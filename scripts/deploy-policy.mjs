// A binding-generation outage may be retried. Invalid code, auth and limit errors stop immediately.
export const retryableDeployment = (output) =>
  /binding [^\n]+ of type d1 failed to generate[\s\S]*10021/i.test(output);
