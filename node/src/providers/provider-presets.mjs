const PRESETS = Object.freeze([
  Object.freeze({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: Object.freeze({}),
    homepageUrl: "https://openrouter.ai",
    documentationUrl: "https://openrouter.ai/docs/api-reference/overview"
  })
]);

function clonePreset(preset) {
  return {
    ...preset,
    extraHeaders: { ...preset.extraHeaders }
  };
}

export function listProviderPresets() {
  return PRESETS.map(clonePreset);
}

export function getProviderPreset(id) {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  return preset ? clonePreset(preset) : null;
}
