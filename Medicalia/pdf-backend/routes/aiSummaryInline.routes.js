import { Router } from 'express';
import { createHash } from 'crypto';
// OpenAI désactivé: ne pas appeler d'API externe.
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = Router();

// ===== AI MEDICAL SUMMARY (synthese factuelle) =====
const validateAiSummaryBody = (body) => {
  if (!body || typeof body !== 'object') return 'BODY_MISSING';
  if (!body.personal || typeof body.personal !== 'object') return 'PERSONAL_MISSING';
  if (!Array.isArray(body.ordonnances)) return 'ORDONNANCES_MISSING';
  return null;
};

/**
 * Construit un texte consolide (facts only) a partir de personal + ordonnances
 */
function buildFactsText(personal, ordonnances) {
  // Nettoyer les labels d'actions (limiter a 280 caracteres et garder uniquement la partie apres "ORDONNANCE" si present)
  const cleanActionLabel = (label) => {
    if (!label || typeof label !== 'string') return '';
    let cleaned = label;
    // Garder uniquement la partie apres "ORDONNANCE" si present
    const ordonnanceIndex = cleaned.indexOf('ORDONNANCE');
    if (ordonnanceIndex !== -1) {
      cleaned = cleaned.substring(ordonnanceIndex + 'ORDONNANCE'.length).trim();
    }
    // Limiter a 280 caracteres
    if (cleaned.length > 280) {
      cleaned = cleaned.substring(0, 280) + '...';
    }
    return cleaned;
  };

  const factsText = `
IDENTITE:
- Nom: ${personal.nom ?? "?"}
- Prenom: ${personal.prenom ?? "?"}
- Age: ${personal.age ?? "?"}

ALERTES:
- Allergies: ${personal.allergies?.join(", ") ?? "Aucune"}

ORDONNANCES:
${ordonnances.map(o => {
  const cleanedActions = (o.actions || []).map(a => {
    const cleanedLabel = cleanActionLabel(a.label);
    return `${a.type ?? "autre"} - ${cleanedLabel} - scheduledAt=${a.scheduledAt ?? "null"}`;
  });

  return `
- Ordonnance ${o.id} (${o.category ?? o.type ?? "?"}) date=${o.date ?? "?"}
  Medecin: ${o.medecin?.prenom ?? ""} ${o.medecin?.nom ?? ""} ${o.medecin?.profession ?? ""}
  Medicaments: ${(o.medicaments||[]).map(m=>`${m.medicament ?? m.nom ?? "?"} ${m.dosage ?? ""} ${m.posologie ?? m.frequence ?? ""} ${m.duration ?? m.duree ?? ""}`).join(" | ") || "Aucun"}
  Actions: ${cleanedActions.join(" | ") || "Aucune"}
`;
}).join("\n")}
`;

  return factsText.trim();
}

/**
 * Detecte le type d'action depuis une ordonnance
 */
function detectActionType(ord) {
  const label = generateActionLabel(ord).toLowerCase();

  if (label.includes('radio') || label.includes('scanner') || label.includes('irm') || label.includes('echographie') || label.includes('imagerie')) {
    return 'imagerie';
  }
  if (label.includes('prise de sang') || label.includes('analyse') || label.includes('laboratoire')) {
    return 'analyse';
  }
  if (label.includes('consultation') || label.includes('rdv') || label.includes('rendez-vous')) {
    return 'consultation';
  }
  return 'autre';
}

/**
 * Genere un label pour une action
 */
function generateActionLabel(ord) {
  // Si l'ordonnance contient des medicaments, essayer d'en deduire l'action
  if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
    const firstMed = ord.medicaments[0];
    if (firstMed.nom) {
      return firstMed.nom;
    }
  }

  // Sinon, utiliser un label generique
  if (ord.type === 'rendez_vous') {
    return 'Rendez-vous medical';
  }

  return 'Action medicale';
}

/**
 * Calcule le statut d'un traitement selon dates/duree
 */
function calculateTreatmentStatus(traitement, ordDate) {
  if (!ordDate) return 'INCONNU';

  const startDate = new Date(ordDate);
  if (isNaN(startDate.getTime())) return 'INCONNU';

  if (traitement.duree) {
    // Parser la duree (ex: "7 jours", "1 mois")
    const dureeMatch = traitement.duree.match(/(\d+)\s*(jour|jours|mois|semaine|semaines)/i);
    if (dureeMatch) {
      const value = parseInt(dureeMatch[1]);
      const unit = dureeMatch[2].toLowerCase();

      let daysToAdd = 0;
      if (unit.includes('jour')) daysToAdd = value;
      else if (unit.includes('semaine')) daysToAdd = value * 7;
      else if (unit.includes('mois')) daysToAdd = value * 30;

      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + daysToAdd);
      const now = new Date();

      if (now < startDate) return 'PLANIFIE';
      if (now > endDate) return 'TERMINE';
      return 'EN_COURS';
    }
  }

  // Si pas de duree, verifier si la date est passee
  const now = new Date();
  if (now < startDate) return 'PLANIFIE';
  // Si date passee sans duree, on ne peut pas savoir
  return 'INCONNU';
}

/**
 * Extrait le texte de la reponse OpenAI de maniere robuste
 */
function extractTextFromOpenAIResponse(resp) {
  // Responses API: resp.output_text
  if (resp && typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  // Responses API alternative: resp.output[].content[].text
  try {
    const out = resp?.output;
    if (Array.isArray(out)) {
      for (const item of out) {
        const content = item?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            const t = c?.text;
            if (typeof t === "string" && t.trim()) return t.trim();
          }
        }
      }
    }
  } catch (_) {}

  // Chat Completions: resp.choices[0].message.content
  const chatText = resp?.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.trim()) return chatText.trim();

  // fallback: empty string
  return "";
}

/**
 * Genere un resume texte simple via OpenAI SDK
 */
async function generateSummaryText(factsText, openaiApiKey) {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 60000;

  const systemPrompt = `Tu fais une synthese factuelle des ordonnances et infos declarees. Aucun diagnostic, aucun conseil medical, aucune interpretation clinique. Tu peux reformuler et regrouper. Statut organisationnel possible: PLANIFIE si scheduledAt present, sinon A_FAIRE. N'invente rien. Reponds uniquement par un texte simple en francais, 2 a 5 phrases max.`;

  const userPrompt = `Fais une synthese simple et utile a partir de ces faits:\n\n${factsText}`;

  const client = new OpenAI({ apiKey: openaiApiKey });

  // Retry logic
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`[AI_SUMMARY] Appel OpenAI (tentative ${attempt}/${MAX_RETRIES + 1})...`);

      // Gerer le timeout avec Promise.race
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('OpenAI API timeout after 60 seconds'));
        }, TIMEOUT_MS);
      });

      const completion = await Promise.race([
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        timeoutPromise
      ]);

      // Logs de debug pour la structure de reponse
      console.log("[AI_SUMMARY] OpenAI resp keys:", Object.keys(completion || {}));
      console.log("[AI_SUMMARY] has output_text:", typeof completion?.output_text, "output_len:", completion?.output_text?.length || 0);
      console.log("[AI_SUMMARY] has output array:", Array.isArray(completion?.output), "output_items:", completion?.output?.length || 0);
      console.log("[AI_SUMMARY] has choices:", Array.isArray(completion?.choices), "choices_len:", completion?.choices?.length || 0);

      // Extraire le texte de maniere robuste
      const summary = extractTextFromOpenAIResponse(completion);

      if (!summary || summary.length === 0) {
        throw new Error('OpenAI response missing or invalid summary text');
      }

      console.log('[AI_SUMMARY] Resume texte recu avec succes');
      return summary;

    } catch (error) {
      lastError = error;
      console.warn(`[AI_SUMMARY] Tentative ${attempt} echouee:`, error.message);
      if (attempt <= MAX_RETRIES) {
        const delay = attempt * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

const aiSummaryHandler = async (req, res) => {
  console.log('[AI_SUMMARY] HIT', req.method, req.originalUrl);

  try {
    // Validation
    const err = validateAiSummaryBody(req.body);
    if (err) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY', detail: err });
    }

    // Recuperer la cle OpenAI
    const OPENAI_KEY = req.app.locals.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      console.error('[AI_SUMMARY] ❌ OPENAI_API_KEY absente');
      return res.status(500).json({
        ok: false,
        error: 'OPENAI_API_KEY_MISSING',
        message: 'Cle API OpenAI non configuree'
      });
    }

    // Construire le texte consolide (facts only)
    const factsText = buildFactsText(req.body.personal, req.body.ordonnances);

    console.log("[AI_SUMMARY] factsText length =", factsText.length);

    // Generer le resume texte via OpenAI
    const summary = await generateSummaryText(factsText, OPENAI_KEY);

    if (!summary || summary.trim().length === 0) {
      console.error('[AI_SUMMARY] ❌ Empty summary after extraction');
      return res.status(500).json({
        ok: false,
        error: 'EMPTY_SUMMARY',
        message: 'Le resume genere est vide'
      });
    }

    console.log("[AI_SUMMARY] ✅ summaryLength =", summary.length);

    // Retourner avec ok:true et summary
    return res.status(200).json({
      ok: true,
      summary: summary,
      serverBuild: "AI_SUMMARY_OPENAI_V2",
      serverTime: new Date().toISOString()
    });

  } catch (error) {
    console.error('[AI_SUMMARY] Erreur:', error.message);
    if (error.stack) {
      console.error('[AI_SUMMARY] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'OPENAI_ERROR',
      message: 'Erreur lors de la generation du resume medical'
    });
  }
};

/**
 * Formate un complement alimentaire pour le resume medical
 *
 * @param {Object} supplement - Complement a formater
 * @returns {string} - Texte formate pour le resume
 */
function formatSupplementForSummary(supplement) {
  const parts = [];

  // Nom (title)
  if (supplement.title) {
    parts.push(supplement.title);
  }

  // Frequence (schedule)
  if (supplement.schedule && typeof supplement.schedule === 'object') {
    const schedule = supplement.schedule;
    const freqParts = [];

    if (schedule.mode === 'daily') {
      freqParts.push('quotidien');
    } else if (schedule.mode === 'weekly') {
      const days = schedule.daysOfWeek || [];
      const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const dayLabels = days.map(d => dayNames[d]).filter(Boolean);
      if (dayLabels.length > 0) {
        freqParts.push(`hebdomadaire (${dayLabels.join(', ')})`);
      } else {
        freqParts.push('hebdomadaire');
      }
    } else if (schedule.mode === 'monthly') {
      freqParts.push(`mensuel (jour ${schedule.dayOfMonth || '?'})`);
    }

    if (schedule.times && Array.isArray(schedule.times) && schedule.times.length > 0) {
      freqParts.push(`a ${schedule.times.join(', ')}`);
    }

    if (freqParts.length > 0) {
      parts.push(`Frequence: ${freqParts.join(' ')}`);
    }
  }

  // Periode (start_date -> end_date)
  if (supplement.start_date || supplement.end_date) {
    const periodParts = [];
    if (supplement.start_date) {
      const startDate = new Date(supplement.start_date);
      if (!isNaN(startDate.getTime())) {
        periodParts.push(`depuis ${startDate.toLocaleDateString('fr-FR')}`);
      }
    }
    if (supplement.end_date) {
      const endDate = new Date(supplement.end_date);
      if (!isNaN(endDate.getTime())) {
        periodParts.push(`jusqu'au ${endDate.toLocaleDateString('fr-FR')}`);
      }
    }
    if (periodParts.length > 0) {
      parts.push(`Periode: ${periodParts.join(' ')}`);
    }
  }

  // Notes
  if (supplement.notes && supplement.notes.trim()) {
    parts.push(`Notes: ${supplement.notes.trim()}`);
  }

  return parts.length > 0 ? parts.join(' | ') : supplement.title || 'Complement';
}

/**
 * Recupere les complements actifs pour un profile_id
 *
 * @param {string} userId - ID de l'utilisateur
 * @param {string} profileId - ID du profil (optionnel)
 * @returns {Promise<Array>} - Liste des complements
 */
async function fetchActiveSupplements(userId, profileId) {
  if (!supabaseAdmin) {
    console.warn('[AI_SUMMARY_V2] Supabase admin non disponible, skip complements');
    return [];
  }

  try {
    let query = supabaseAdmin
      .from('supplements')
      .select('*')
      .eq('owner_user_id', userId)
      .in('status', ['active', 'paused']); // Actifs et paused

    if (profileId) {
      query = query.eq('profile_id', profileId);
    }

    const { data: supplements, error } = await query;

    if (error) {
      console.warn('[AI_SUMMARY_V2] Erreur recuperation complements:', error.message);
      return [];
    }

    return supplements || [];
  } catch (error) {
    console.warn('[AI_SUMMARY_V2] Erreur recuperation complements:', error.message);
    return [];
  }
}

// ===== AI MEDICAL SUMMARY V2 HANDLER (hoistee pour eviter TDZ) =====
async function aiSummaryV2Handler(req, res) {
  console.log('[AI_SUMMARY_V2] HIT', req.method, req.originalUrl);

  try {
    // Validation
    const err = validateAiSummaryBody(req.body);
    if (err) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY', detail: err });
    }

    const personal = req.body.personal;
    const ordonnances = req.body.ordonnances;
    const healthProfile = req.body.healthProfile; // Optionnel
    const profileId = req.body.profile_id || req.query.profile_id; // Optionnel

    // Recuperer l'utilisateur si authentifie (pour recuperer les complements)
    const userId = req.userId || req.user?.id;

    // Securite: ne pas logger healthProfile en clair
    const healthProfileHash = healthProfile
      ? createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 8)
      : null;
    if (healthProfile) {
      console.log(`[AI_SUMMARY_V2] healthProfile recu (hash: ${healthProfileHash})`);
    }

    // Recuperer les complements alimentaires actifs si userId et profileId disponibles
    let supplements = [];
    if (userId && profileId) {
      try {
        supplements = await fetchActiveSupplements(userId, profileId);
        console.log(`[AI_SUMMARY_V2] ${supplements.length} complement(s) recupere(s) pour profile_id=${profileId}`);
      } catch (suppError) {
        console.warn('[AI_SUMMARY_V2] Erreur recuperation complements (non bloquant):', suppError.message);
        supplements = [];
      }
    } else {
      if (!userId) {
        console.log('[AI_SUMMARY_V2] userId non disponible, skip complements');
      }
      if (!profileId) {
        console.log('[AI_SUMMARY_V2] profile_id non fourni, skip complements');
      }
    }

    // IMPORTANT: Si un cache est implemente, la cle doit inclure healthProfile et supplements pour eviter un mauvais cache
    // Exemple de cacheKey: userId + ":" + hash(ordonnances) + ":" + (healthProfile.updatedAt || hash(healthProfile)) + ":" + hash(supplements)
    // Cela garantit que le resume se regenere si le HealthProfile ou les complements changent
    // const cacheKey = `${userId}:${hashOrdonnances}:${healthProfile?.updatedAt || hashHealthProfile}:${hashSupplements}`;

    // Construire factsText pour OpenAI (SANS identite)
    const factsParts = [];

    // Allergies (depuis personal, pas depuis healthProfile - ce sont des sources differentes)
    if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
      factsParts.push(`Allergies (ordonnances): ${personal.allergies.join(', ')}`);
    }

    // Medicaments
    const medLines = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
        ord.medicaments.forEach(med => {
          const medParts = [];
          if (med.medicament || med.nom) medParts.push(med.medicament || med.nom);
          if (med.dosage) medParts.push(med.dosage);
          if (med.posologie || med.frequence) medParts.push(med.posologie || med.frequence);
          if (med.duration || med.duree) medParts.push(med.duration || med.duree);
          if (medParts.length > 0) {
            medLines.push(`- ${medParts.join(' - ')}`);
          }
        });
      }
    });
    if (medLines.length > 0) {
      factsParts.push('Medicaments:');
      factsParts.push(...medLines);
    }

    // Actions/RDV
    const actionLines = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.actions) && ord.actions.length > 0) {
        ord.actions.forEach(action => {
          let label = action.label || '';

          // Extraire une phrase courte du label
          if (label.includes('Faire realiser')) {
            const index = label.indexOf('Faire realiser');
            label = label.substring(index).trim();
          } else if (label.includes('ORDONNANCE')) {
            const index = label.indexOf('ORDONNANCE');
            label = label.substring(index + 'ORDONNANCE'.length).trim();
          }

          // Limiter a 180 caracteres
          if (label.length > 180) {
            label = label.substring(0, 180) + '...';
          }

          const scheduledAt = action.scheduledAt;
          const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';

          if (label) {
            actionLines.push(`- ${label} (${status})`);
          }
        });
      }
    });
    if (actionLines.length > 0) {
      factsParts.push('Actions/RDV:');
      factsParts.push(...actionLines);
    }

    // Ajouter TOUT le contexte HealthProfile (declaratif) si present
    if (healthProfile && typeof healthProfile === 'object') {
      factsParts.push('\n=== CONTEXTE DECLARE PAR L\'UTILISATEUR (HEALTHPROFILE) ===');
      factsParts.push('IMPORTANT: Ces informations sont declaratives, ne pas inferer. Utiliser uniquement ce qui est present.');

      // Allergies
      if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
        factsParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
      }

      // Maladies chroniques (chronicConditions ou chronicDiseases)
      const chronicConditions = healthProfile.chronicConditions || healthProfile.chronicDiseases;
      if (Array.isArray(chronicConditions) && chronicConditions.length > 0) {
        factsParts.push(`Maladies chroniques: ${chronicConditions.join(', ')}`);
      }

      // Traitements (treatments ou longTermTreatments)
      const treatments = healthProfile.treatments || healthProfile.longTermTreatments;
      if (Array.isArray(treatments) && treatments.length > 0) {
        const treatmentLines = treatments.map(t => {
          if (typeof t === 'string') return t;
          if (typeof t === 'object') {
            const parts = [];
            if (t.name) parts.push(t.name);
            if (t.dosage) parts.push(`(${t.dosage})`);
            if (t.frequency) parts.push(`- ${t.frequency}`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (treatmentLines.length > 0) {
          factsParts.push(`Traitements en cours: ${treatmentLines.join(' ; ')}`);
        }
      }

      // Chirurgies (surgeries)
      if (healthProfile.surgeries && Array.isArray(healthProfile.surgeries) && healthProfile.surgeries.length > 0) {
        const surgeryLines = healthProfile.surgeries.map(s => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object') {
            const parts = [];
            if (s.name) parts.push(s.name);
            if (s.date) parts.push(`(${s.date})`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (surgeryLines.length > 0) {
          factsParts.push(`Chirurgies: ${surgeryLines.join(' ; ')}`);
        }
      }

      // Contacts medecins (doctorContacts)
      if (healthProfile.doctorContacts && Array.isArray(healthProfile.doctorContacts) && healthProfile.doctorContacts.length > 0) {
        const doctorLines = healthProfile.doctorContacts.map(doc => {
          if (typeof doc === 'string') return doc;
          if (typeof doc === 'object') {
            const parts = [];
            if (doc.name) parts.push(doc.name);
            if (doc.specialty) parts.push(`(${doc.specialty})`);
            if (doc.phone) parts.push(`- ${doc.phone}`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (doctorLines.length > 0) {
          factsParts.push(`Contacts medecins: ${doctorLines.join(' ; ')}`);
        }
      }

      // Contact d'urgence (emergencyContact)
      if (healthProfile.emergencyContact) {
        const contact = healthProfile.emergencyContact;
        const contactParts = [];
        if (contact.name) contactParts.push(contact.name);
        if (contact.phone) contactParts.push(contact.phone);
        if (contact.relationship) contactParts.push(`(${contact.relationship})`);
        if (contactParts.length > 0) {
          factsParts.push(`Contact d'urgence: ${contactParts.join(' ')}`);
        }
      }

      // Notes (notes ou otherInfo)
      const notes = healthProfile.notes || healthProfile.otherInfo;
      if (notes) {
        if (typeof notes === 'string' && notes.trim()) {
          factsParts.push(`Notes: ${notes.trim()}`);
        } else if (Array.isArray(notes) && notes.length > 0) {
          factsParts.push(`Notes: ${notes.join(' ; ')}`);
        }
      }

      // Tous les autres champs du HealthProfile (pour ne rien oublier)
      Object.keys(healthProfile).forEach(key => {
        if (!['allergies', 'chronicConditions', 'chronicDiseases', 'treatments', 'longTermTreatments',
              'surgeries', 'doctorContacts', 'emergencyContact', 'notes', 'otherInfo', 'updatedAt'].includes(key)) {
          const value = healthProfile[key];
          if (value !== null && value !== undefined && value !== '') {
            if (Array.isArray(value) && value.length > 0) {
              factsParts.push(`${key}: ${value.join(', ')}`);
            } else if (typeof value === 'object' && Object.keys(value).length > 0) {
              factsParts.push(`${key}: ${JSON.stringify(value)}`);
            } else if (typeof value === 'string' && value.trim()) {
              factsParts.push(`${key}: ${value.trim()}`);
            }
          }
        }
      });
    }

    // Ajouter les complements alimentaires
    if (supplements && supplements.length > 0) {
      factsParts.push('\n=== COMPLEMENTS ALIMENTAIRES ===');
      supplements.forEach(supp => {
        const formatted = formatSupplementForSummary(supp);
        factsParts.push(`- ${formatted}`);
      });
    } else {
      factsParts.push('\n=== COMPLEMENTS ALIMENTAIRES ===');
      factsParts.push('Aucun');
    }

    const factsText = factsParts.join('\n');

    // Generer le resume fallback (toujours disponible) - SANS identite
    const fallbackParts = [];

    const medicaments = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
        ord.medicaments.forEach(med => {
          const medName = med.medicament || med.nom || '';
          const dosage = med.dosage || '';
          if (medName) {
            medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
          }
        });
      }
    });

    if (medicaments.length > 0) {
      const medCount = medicaments.length;
      fallbackParts.push(`a ${medCount} medicament(s): ${medicaments.join(', ')}`);
    }

    const actions = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.actions) && ord.actions.length > 0) {
        ord.actions.forEach(action => {
          let label = action.label || '';
          const ordonnanceIndex = label.indexOf('ORDONNANCE');
          if (ordonnanceIndex !== -1) {
            label = label.substring(ordonnanceIndex + 'ORDONNANCE'.length).trim();
          }
          const scheduledAt = action.scheduledAt;
          const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';
          if (label) {
            actions.push(`${label} (${status})`);
          }
        });
      }
    });

    if (actions.length > 0) {
      const actionCount = actions.length;
      fallbackParts.push(`${actionCount} action(s): ${actions.join(', ')}`);
    }

    if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
      fallbackParts.push(`Allergies: ${personal.allergies.join(', ')}`);
    }

    // Ajouter les complements dans le fallback
    if (supplements && supplements.length > 0) {
      const suppTexts = supplements.map(supp => formatSupplementForSummary(supp));
      fallbackParts.push(`Complements alimentaires: ${suppTexts.join(' ; ')}`);
    } else {
      fallbackParts.push('Complements alimentaires: Aucun');
    }

    let fallbackSummary = fallbackParts.join(' ; ');
    if (!fallbackSummary || fallbackSummary.trim().length === 0) {
      fallbackSummary = 'Aucune information medicale disponible.';
    }

    // Tenter OpenAI
    let summary = '';
    let source = 'fallback';

    const OPENAI_KEY = process.env.OPENAI_API_KEY || req.app.locals?.OPENAI_API_KEY;

    if (OPENAI_KEY) {
      try {
        const client = new OpenAI({ apiKey: OPENAI_KEY });

        // Construire le prompt systeme avec instructions strictes
        let systemPrompt = `Tu fais une synthese factuelle medicale. Aucun diagnostic, aucun conseil medical, aucune interpretation clinique. N'invente rien.

REGLES STRICTES:
- Ne JAMAIS inclure de section "Identite", "Patient", "Nom", "Prenom", "Date de naissance" dans le resume.
- Ne JAMAIS afficher de donnees nominatives (nom, prenom, age).
- Structure la reponse en sections recommandees:
  * "Antecedents & allergies"
  * "Traitements en cours"
  * "Complements alimentaires"
  * "Rendez-vous & examens"
  * "Points d'attention"
- Utilise uniquement les informations presentes dans le contexte fourni.
- Si une information n'est pas dans le contexte, ne l'invente pas.
- Pour la section "Complements alimentaires", utilise les informations de la section "COMPLEMENTS ALIMENTAIRES" du contexte. Si cette section indique "Aucun", indique "Aucun complement alimentaire".`;

        if (healthProfile) {
          systemPrompt += `\n\nIMPORTANT: La section "CONTEXTE DECLARE PAR L'UTILISATEUR (HEALTHPROFILE)" contient des informations declaratives fournies par l'utilisateur. Ce sont des informations declaratives, ne pas inferer. Utilise-les uniquement si elles sont presentes dans cette section.`;
        }

        const completion = await Promise.race([
          client.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.1,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: factsText }
            ]
          }),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('OpenAI API timeout after 60 seconds'));
            }, 60000);
          })
        ]);

        // Extraire le texte de maniere robuste
        summary = extractTextFromOpenAIResponse(completion);

        if (summary && summary.trim().length > 0) {
          source = 'openai';
        }
      } catch (openaiError) {
        console.warn('[AI_SUMMARY_V2] OpenAI error:', openaiError.message);
      }
    }

    // Si OpenAI n'a pas fourni de texte, utiliser le fallback
    if (!summary || summary.trim().length === 0) {
      summary = fallbackSummary;
      source = 'fallback';
    }

    // Inclure TOUT le healthProfile dans le fallback si present (SANS identite)
    if (source === 'fallback' && healthProfile) {
      const healthParts = [];

      // Allergies
      if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
        healthParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
      }

      // Maladies chroniques (chronicConditions ou chronicDiseases)
      const chronicConditions = healthProfile.chronicConditions || healthProfile.chronicDiseases;
      if (Array.isArray(chronicConditions) && chronicConditions.length > 0) {
        healthParts.push(`Maladies chroniques: ${chronicConditions.join(', ')}`);
      }

      // Traitements (treatments ou longTermTreatments)
      const treatments = healthProfile.treatments || healthProfile.longTermTreatments;
      if (Array.isArray(treatments) && treatments.length > 0) {
        const treatmentNames = treatments.map(t => {
          if (typeof t === 'string') return t;
          if (typeof t === 'object' && t.name) return t.name;
          return '';
        }).filter(Boolean);
        if (treatmentNames.length > 0) {
          healthParts.push(`Traitements: ${treatmentNames.join(', ')}`);
        }
      }

      // Chirurgies
      if (healthProfile.surgeries && Array.isArray(healthProfile.surgeries) && healthProfile.surgeries.length > 0) {
        const surgeryNames = healthProfile.surgeries.map(s => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object' && s.name) return s.name;
          return '';
        }).filter(Boolean);
        if (surgeryNames.length > 0) {
          healthParts.push(`Chirurgies: ${surgeryNames.join(', ')}`);
        }
      }

      if (healthParts.length > 0) {
        summary += (summary ? ' | ' : '') + healthParts.join(' | ');
      }
    }

    console.log("[AI_SUMMARY_V2] source=", source, "summaryLength=", summary.length, "healthProfile=", healthProfile ? `hash:${healthProfileHash}` : 'none');

    // Toujours retourner 200 avec summary non vide
    return res.status(200).json({
      ok: true,
      summary: summary,
      source: source,
      serverBuild: "AI_SUMMARY_V2",
      serverTime: new Date().toISOString()
    });

  } catch (error) {
    console.error('[AI_SUMMARY_V2] Erreur:', error.message);
    if (error.stack) {
      console.error('[AI_SUMMARY_V2] Stack:', error.stack);
    }

    // Meme en cas d'erreur, generer un fallback minimal
    return res.status(200).json({
      ok: true,
      summary: 'Resume medical non disponible.',
      source: 'fallback',
      serverBuild: "AI_SUMMARY_V2",
      serverTime: new Date().toISOString()
    });
  }
}

console.log('✅ [AI_SUMMARY_V2] handler ready');

router.get('/ai/medical-summary/health', (req, res) => res.status(200).json({ ok: true, path: req.originalUrl }));
router.get('/ai/medical_summary/health', (req, res) => res.status(200).json({ ok: true, path: req.originalUrl }));
router.post('/ai/medical-summary', aiSummaryHandler);
router.post('/ai/medical_summary', aiSummaryHandler);
router.post('/ai/medical-summary-v2', aiSummaryV2Handler);
router.post('/ai/medical_summary_v2', aiSummaryV2Handler);

// ===== AI MEDICAL SUMMARY V2 (avec fallback garanti) =====
/**
 * Construit un texte court pour OpenAI (version simplifiee)
 */
function buildFactsTextShort(personal, ordonnances) {
  const parts = [];

  // Nom
  if (personal.nom || personal.prenom) {
    const name = [personal.prenom, personal.nom].filter(Boolean).join(' ').toUpperCase();
    if (name) parts.push(name);
  }

  // Allergies
  if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
    parts.push(`Allergie renseignee : ${personal.allergies.join(', ')}.`);
  }

  // Medicaments
  const medicaments = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
      ord.medicaments.forEach(med => {
        const medName = med.medicament || med.nom || '';
        const dosage = med.dosage || '';
        if (medName) {
          medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
        }
      });
    }
  });

  if (medicaments.length > 0) {
    parts.push(`Ordonnance de ${medicaments.join(' et ')}.`);
  }

  // Actions
  const actions = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.actions) && ord.actions.length > 0) {
      ord.actions.forEach(action => {
        const label = action.label || '';
        const scheduledAt = action.scheduledAt;
        const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';
        if (label) {
          actions.push(`${label} (${status})`);
        }
      });
    }
  });

  if (actions.length > 0) {
    const actionText = actions.length === 1
      ? `Une ${actions[0].toLowerCase()} est planifiee.`
      : `Actions : ${actions.join(', ')}.`;
    parts.push(actionText);
  }

  return parts.join(' ');
}

/**
 * Genere un resume fallback deterministe
 */
function generateFallbackSummary(personal, ordonnances) {
  const parts = [];

  // Nom
  if (personal.nom || personal.prenom) {
    const name = [personal.prenom, personal.nom].filter(Boolean).join(' ').toUpperCase();
    if (name) parts.push(`${name} a`);
  } else {
    parts.push('Le patient a');
  }

  // Medicaments
  const medicaments = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
      ord.medicaments.forEach(med => {
        const medName = med.medicament || med.nom || '';
        const dosage = med.dosage || '';
        if (medName) {
          medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
        }
      });
    }
  });

  if (medicaments.length > 0) {
    parts.push(`une ordonnance de ${medicaments.join(' et ')}.`);
  }

  // Actions
  const actions = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.actions) && ord.actions.length > 0) {
      ord.actions.forEach(action => {
        const label = action.label || '';
        const scheduledAt = action.scheduledAt;
        if (label) {
          if (scheduledAt) {
            actions.push(`Une imagerie est planifiee (${label.toLowerCase()})`);
          } else {
            actions.push(`Une action est a faire (${label.toLowerCase()})`);
          }
        }
      });
    }
  });

  if (actions.length > 0) {
    parts.push(actions.join('. ') + '.');
  }

  // Allergies
  if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
    parts.push(`Allergie renseignee : ${personal.allergies.join(', ')}.`);
  }

  return parts.join(' ') || 'Aucune information medicale disponible.';
}

export default router;
