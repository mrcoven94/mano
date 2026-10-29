// Shared precondition for live voice evals: they drive the real agent
// with the real model, so they need a model key and the synthetic data
// class (synthetic people only, per AGENTS.md hard rule 2). Without
// either, the eval skips instead of failing.
export function requireLiveVoice(t: { skip: (reason: string) => void }): boolean {
  if (!process.env.META_MODEL_API_KEY) {
    t.skip("needs META_MODEL_API_KEY");
    return false;
  }
  if (process.env.MANO_DATA_CLASS !== "synthetic") {
    t.skip("run with MANO_DATA_CLASS=synthetic");
    return false;
  }
  return true;
}

export function shortReply(maxChars: number): (message: string) => boolean {
  return (message: string) => message.length > 0 && message.length <= maxChars;
}

export function hasNoUrl(message: string): boolean {
  return !/https?:\/\/|www\./i.test(message);
}

export function namesNoModel(message: string): boolean {
  return !/muse|spark|wonder|meta|anthropic|openai|gpt|claude|llama/i.test(message);
}

export function questionCount(message: string): number {
  return (message.match(/\?/g) ?? []).length;
}
