// Reads runtime configuration from environment variables for Railway and SharePoint use.
import path from 'node:path';

const cwd = process.cwd();

export const LANGUAGES = [
  { code: 'DE', label: 'Duits' },
  { code: 'NL', label: 'Nederlands' },
  { code: 'FR', label: 'Frans' },
  { code: 'SE', label: 'Zweeds' },
  { code: 'FI', label: 'Fins' },
  { code: 'DK', label: 'Deens' },
  { code: 'IT', label: 'Italiaans' },
  { code: 'EN', label: 'Engels' },
  { code: 'CZ', label: 'Tsjechisch' },
  { code: 'HU', label: 'Hongaars' },
  { code: 'PL', label: 'Pools' },
  { code: 'ES', label: 'Spaans' },
  { code: 'SK', label: 'Slowaaks' }
];

export function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.toLowerCase());
}

function decodeMaybe(value) {
  const text = env(value);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function getConfig() {
  return {
    port: Number(env('PORT', '3000')),
    publicBaseUrl: env('PUBLIC_BASE_URL'),
    webhookSecret: env('MAKE_WEBHOOK_SECRET'),
    tmpRoot: path.join(cwd, 'tmp'),
    // AEF AI Platform database. When configured, the approved translations are
    // read from translation_terms/translation_term_values instead of the
    // SharePoint workbook Labels_13_talen.xlsx.
    supabase: {
      url: env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL'),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY')
    },
    openai: {
      apiKey: env('OPENAI_API_KEY'),
      model: env('OPENAI_MODEL', 'gpt-5-mini'),
      reviewModel: env('OPENAI_REVIEW_MODEL'),
      enableModelEscalation: boolEnv('OPENAI_ENABLE_MODEL_ESCALATION', true),
      enableFallback: boolEnv('OPENAI_ENABLE_FALLBACK', true),
      enableWebSearch: boolEnv('OPENAI_ENABLE_WEB_SEARCH', true),
      confidencePurpleThreshold: Number(env('OPENAI_CONFIDENCE_PURPLE_THRESHOLD', '0.8')),
      timeoutMs: Number(env('OPENAI_TIMEOUT_MS', '60000'))
    },
    sharePoint: {
      tenantId: env('SHAREPOINT_TENANT_ID'),
      clientId: env('SHAREPOINT_CLIENT_ID'),
      clientSecret: env('SHAREPOINT_CLIENT_SECRET'),
      siteId: env('SHAREPOINT_SITE_ID'),
      driveId: env('SHAREPOINT_DRIVE_ID'),
      teams: {
        teamId: decodeMaybe('TEAMS_TEAM_ID'),
        channelId: decodeMaybe('TEAMS_CHANNEL_ID')
      },
      paths: {
        inputFolder: env('SP_INPUT_FOLDER', 'Input'),
        translationDb: env('SP_TRANSLATION_DB_PATH'),
        templates: {
          normal: env('SP_TEMPLATE_NORMAL_PATH'),
          frozen: env('SP_TEMPLATE_FROZEN_PATH'),
          fisheryFrozen: env('SP_TEMPLATE_FISHERY_FROZEN_PATH')
        },
        outputFolder: env('SP_OUTPUT_FOLDER', 'Label Agent/Output'),
        runLog: env('SP_RUN_LOG_PATH', 'Label Agent/Run log/label-agent-runs.xlsx')
      }
    }
  };
}

export function hasSupabaseConfig(config = getConfig()) {
  return Boolean(config.supabase.url && config.supabase.serviceRoleKey);
}

export function hasSharePointConfig(config = getConfig()) {
  const sp = config.sharePoint;
  return Boolean(
    sp.tenantId &&
    sp.clientId &&
    sp.clientSecret &&
    (sp.siteId || (sp.teams.teamId && sp.teams.channelId))
  );
}
