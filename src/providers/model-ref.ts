export function parseModelRef(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`invalid model reference "${model}"`);
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}
