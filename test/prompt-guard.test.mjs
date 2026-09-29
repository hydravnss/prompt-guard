// Test Node (sans SillyTavern) : node test/prompt-guard.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
const extDir = path.join(root, 'scripts/extensions/third-party/prompt-guard');
fs.mkdirSync(extDir, { recursive: true });
fs.copyFileSync(path.join(here, '../index.js'), path.join(extDir, 'index.js'));
fs.writeFileSync(path.join(root, 'script.js'), `
export const eventSource = { on: (e, f) => { (globalThis.__h[e] ||= []).push(f); } };
export const event_types = { MESSAGE_RECEIVED: 'mr', CHARACTER_MESSAGE_RENDERED: 'cmr', MESSAGE_SENT: 'ms', CHAT_CHANGED: 'cc',
  CHAT_COMPLETION_PROMPT_READY: 'ccpr', GENERATE_AFTER_COMBINE_PROMPTS: 'gacp' };
export const saveSettingsDebounced = () => {};
export const isGenerating = () => false;
export const main_api = 'openai';
export const extension_prompt_types = { IN_CHAT: 1 };
export const extension_prompt_roles = { SYSTEM: 0 };
export const setExtensionPrompt = () => {};
`);
fs.writeFileSync(path.join(root, 'scripts/extensions.js'), `
export const extension_settings = globalThis.__settings;
export const getContext = () => globalThis.__ctx;
`);

globalThis.__h = {};
globalThis.__settings = {};
const chat = [{ is_user: true, mes: 'salut' }, { name: 'Bob', mes: 'x' }];
const swipes = [];
globalThis.__ctx = {
    chat, name1: 'Moi', name2: 'Bob', characters: [], characterId: undefined,
    getCurrentChatId: () => 'c1',
    swipe: { to: async (...a) => { swipes.push(a); } },
    saveChat: async () => {}, updateMessageBlock: () => {},
};
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };

const mod = await import(pathToFileURL(path.join(extDir, 'index.js')).href);
const T = mod.__test;
const settings = T.getSettings();
const h = globalThis.__h;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

// --- réglages : fusion pour anciens utilisateurs
{
    for (const k of Object.keys(globalThis.__settings)) delete globalThis.__settings[k];
    globalThis.__settings['prompt-guard'] = { enabled: true, mode: 'regen', maxRetries: 3, overlapThreshold: 30 };
    const s = T.getSettings();
    ok('ancien réglage conservé', s.mode === 'regen' && s.maxRetries === 3 && s.overlapThreshold === 30);
    ok('nouvelles clés ajoutées', s.fragmentLayer === true && s.promptLayer === true && /dialogue en gras/.test(s.presetPhrases) && s.fragmentMaxLength === 200);
    globalThis.__settings['prompt-guard'] = {};
    T.getSettings();
}

// --- événements enregistrés (sans planter)
ok('handlers de capture enregistrés', h.ccpr?.length === 1 && h.gacp?.length === 1 && h.mr?.length === 1);

const FRAG = ', dialogue en gras et actions en italique.';
const msg = { name: 'Bob' };

// --- couche 3
{
    const s = { ...T.defaultSettings, promptLayer: false };
    const r = T.analyze(FRAG, msg, s);
    ok('couche 3 signale le fragment', r.hard && r.wholeLeak && r.emptied && r.reasons.length > 0);
    const c3 = T.fragmentCheck(FRAG, s);
    ok('fragmentCheck signale (a)', c3.flag && /ponctuation/.test(c3.reasons[0]));
    // (a) sans phrase de preset
    ok('(a) virgule initiale', T.fragmentCheck(', puis il ferme la porte doucement.', s).flag);
    ok('(a) conjonction minuscule', T.fragmentCheck('et actions en italique pour les gestes', { ...s, presetPhrases: '' }).flag);
    ok('(a) longue réponse non signalée', !T.fragmentCheck(', ' + 'mot '.repeat(80), s).flag);
    // (b) vocabulaire de format
    const noPreset = { ...s, presetPhrases: '' };
    ok('(b) vocabulaire FR', T.fragmentCheck('à la troisième personne, minimum 300 mots', noPreset).flag);
    ok('(b) vocabulaire EN', T.fragmentCheck('write in third person, use bold and italic asterisks', noPreset).flag);
    ok('(b) paragraphes', T.fragmentCheck('minimum trois paragraphes', noPreset).flag);
    // (c) liste utilisateur
    ok('(c) phrase perso', T.fragmentCheck('Réponds toujours avec le Style Maison ici', { ...s, presetPhrases: 'STYLE maison' }).flag);
    ok('(c) casse ignorée', T.fragmentCheck('DIALOGUE EN GRAS ET ACTIONS EN ITALIQUE', s).flag);
    // désactivée
    const off = T.analyze(FRAG, msg, { ...s, fragmentLayer: false });
    ok('couche 3 désactivable', !off.hard);
}

// --- (4) retrait en tête
{
    const s = { ...T.defaultSettings, promptLayer: false };
    const r = T.analyze(', dialogue en gras et actions en italique.\nElle hausse les épaules. « Comme tu veux. »', msg, s);
    ok('phrase retirée, reste conservé', !r.hard && r.changed && !r.emptied && r.cleaned === 'Elle hausse les épaules. « Comme tu veux. »');
    const r2 = T.analyze('Dialogue en gras et actions en italique. **Oui.** *Il sourit.*', msg, s);
    ok('phrase en tête (même ligne) retirée', !r2.hard && r2.cleaned === '**Oui.** *Il sourit.*');
    const r3 = T.analyze('*Il sourit* puis dit « dialogue en gras et actions en italique » sans rire, bien plus tard dans la scène du soir, au coin du feu, et c\'était vraiment très long à raconter pour tout le monde, dit-il. ' + 'La nuit tombe sur le village et le feu crépite doucement. '.repeat(3), msg, s);
    ok('phrase au milieu d\'une longue réponse : intacte', !r3.hard && !r3.changed);
}

// --- couche 4
{
    const presetChunk = 'Écris en respectant toujours le format : dialogue en gras et actions en italique. Reste concis et cohérent avec la scène.';
    T.capturePrompt(T.extractSystemText([
        { role: 'system', content: 'Tu es un maître de jeu. ' + presetChunk },
        { role: 'system', content: [{ type: 'text', text: 'Contexte : une taverne au bord de la mer.' }] },
        { role: 'user', content: 'Salut, je suis Moi et je pousse la porte de la taverne.' },
        { role: 'assistant', content: 'Bienvenue voyageur, installe-toi près du feu.' },
    ]), 'chat');
    ok('prompt capturé', T.promptCapture.chars > 50);
    ok('messages user/assistant exclus', !T.promptCapture.wordsStr.includes('bienvenue voyageur'));
    const s = { ...T.defaultSettings, fragmentLayer: false };
    const r = T.analyze(FRAG, msg, s);
    ok('couche 4 signale le fragment', r.hard && r.wholeLeak && r.reasons.some(x => /prompt réel/.test(x)));
    const r2 = T.analyze('Reste concis et cohérent avec la scène, dialogue en gras et actions en italique', msg, s);
    ok('couche 4 (>=60% 3-grammes)', r2.hard && r2.reasons.some(x => /prompt réel/.test(x)));
    ok('couche 4 : réponse issue de l\'historique user non signalée', !T.analyze('Salut, je suis Moi et je pousse la porte de la taverne.', msg, s).hard);
    ok('couche 4 désactivable', !T.analyze(FRAG, msg, { ...s, promptLayer: false }).hard);
    // les deux couches ensemble
    ok('couches 3+4', T.analyze(FRAG, msg, T.defaultSettings).hard);
    // réponse longue : ignorée
    const long = presetChunk + ' ' + 'Il regarde la mer. '.repeat(40);
    ok('couche 4 ignore les réponses longues', !T.analyze(long, msg, { ...s }).hard);
}

// --- pas de faux positifs
{
    const samples = [
        '**Oui.** *Il sourit.*',
        '*Il sourit et hoche la tête.* **« Bien sûr, entre donc ! »**',
        '« Non. » *Elle détourne le regard.*',
        '*Elle croise les bras et hausse un sourcil.* **Tu plaisantes, j\'espère ?**',
        '*Il ouvre la porte en grand.* **Bienvenue !** *Il s\'écarte pour te laisser entrer, un sourire en coin.*',
        '**D\'accord.** *Elle range son épée.* **Mais tu me dois une explication.**',
        '...*Il hésite un instant.* **Peut-être.**',
        '*Il te regarde en silence.* **Hmm.**',
        'Il rit. *Ses yeux brillent.* « Alors, on y va ? »',
        '*Marie s\'assoit.* **Je m\'appelle Marie, et toi ?** *Elle attend ta réponse en jouant avec sa tasse de café.*',
        'Oui.',
        '*Il sourit.*',
        '**Merci !** *Elle t\'enlace brièvement.* Tu es le meilleur, tu sais.',
        '*Elle écrit en gras sur le tableau : « Bienvenue ».* **Voilà, c\'est fait.**',
        'Je ne sais pas trop quoi te répondre, honnêtement.',
        '*Il lève les yeux au ciel.* **Et alors ? Ça change quoi ?**',
        'Yes. *He smiles.* "Of course, come in."',
        '*She nods slowly.* **"I understand."** *She steps aside.*',
        '*Il fronce les sourcils.* **Non, attends,** *dit-il en posant la main sur ton épaule,* **tu ne peux pas y aller seul.**',
        ':) *Il rit.*',
    ];
    for (const withPrompt of [false, true]) {
        if (withPrompt) T.capturePrompt('Tu es Bob, un aubergiste. Écris à la troisième personne, dialogue en gras et actions en italique. Minimum 200 mots. Décris les actions avec précision. Tu réponds toujours en français.', 'chat');
        for (const sm of samples) {
            const r = T.analyze(sm, msg, T.defaultSettings);
            assert.ok(!r.hard && !r.changed, `faux positif (prompt=${withPrompt}) : ${JSON.stringify(sm)} -> ${r.reasons.join(' | ')}`);
            pass++;
        }
    }
}

// --- mode Nettoyer : fuite totale -> 1 swipe puis conservation ; compteur & max
{
    const reset = async () => { await h.cc[0](); await h.ms[0](); };
    const send = async (text) => {
        chat[1] = { name: 'Bob', mes: text };
        await h.mr[0](1, 'normal');
        await new Promise(r => setTimeout(r, 1200));
    };
    T.capturePrompt('Tu es Bob. Écris dialogue en gras et actions en italique.', 'chat');
    const s = T.getSettings();
    s.mode = 'clean';
    await reset();
    swipes.length = 0;
    await send(FRAG);
    ok('Nettoyer : 1 swipe sur fuite totale', swipes.length === 1 && chat[1].mes === FRAG);
    ok('compteur = 1', T.retryState.count === 1);
    await send(FRAG + ' ');
    ok('Nettoyer : pas de 2e swipe (max 1), message conservé', swipes.length === 1 && T.retryState.count === 0);
    await send('*Il sourit.* **Bonjour, voyageur.**');
    ok('réponse propre : compteur à 0', T.retryState.count === 0 && swipes.length === 1);
    // nouveau message utilisateur : le compteur repart
    await send(', dialogue en gras et actions en italique.'); // 1 swipe
    ok('nouveau swipe après remise à zéro', swipes.length === 2 && T.retryState.count === 1);
    await h.ms[0]();
    ok('compteur remis à 0 à l\'envoi', T.retryState.count === 0);

    // Nettoyer : phrase en tête + contenu valide -> nettoyé, sans swipe
    swipes.length = 0;
    await reset();
    await send(', dialogue en gras et actions en italique.\n*Il sourit.* **Salut !**');
    ok('Nettoyer : contenu valide nettoyé sans swipe', swipes.length === 0 && chat[1].mes === '*Il sourit.* **Salut !**');

    // Regénérer : max respecté
    s.mode = 'regen'; s.maxRetries = 2;
    await reset(); swipes.length = 0;
    for (let i = 0; i < 3; i++) await send(FRAG + ' '.repeat(i)); // fuite ×3 : 2 swipes puis conservation
    ok('Regénérer : max 2 swipes respecté', swipes.length === 2);
    ok('Regénérer : compteur remis à 0 après épuisement', T.retryState.count === 0);

    // Avertir : jamais de swipe
    s.mode = 'warn'; swipes.length = 0; await reset();
    await send(FRAG);
    ok('Avertir : aucun swipe', swipes.length === 0 && chat[1].mes === FRAG);
}

console.log(`OK : ${pass} vérifications`);
process.exit(0);
