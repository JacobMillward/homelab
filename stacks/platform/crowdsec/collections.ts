// The crowdsec image splits COLLECTIONS on whitespace; a comma makes it look for one collection.
export function collectionsEnv(names: string[]): string {
  for (const n of names) {
    if (/[\s,]/.test(n)) throw new Error(`collection name "${n}" must not contain whitespace or a comma`);
  }
  return names.join(" ");
}
