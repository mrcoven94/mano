// Committed suite pins. A changed case changes the hash; the pins test then
// fails until the author bumps the suite version and re-pins on purpose.
// Never loosen or delete a case to let a model pass.

export const SUITE_PINS: Record<string, { version: number; cases: number; sha256: string }> = {
  chat: { version: 1, cases: 40, sha256: "8aa71d182f91fc651efa154a7abe651e672d231d537c18b6e1a553b5076c652b" },
  text: { version: 1, cases: 25, sha256: "8791e23f793b43e45d3ef7df6a0cf756e9064e833dd0b313733f7ac588509faf" },
  letters: { version: 2, cases: 23, sha256: "0b5017a0619ab57ad7ecce1dfe564f7dc7db47108e4bdfff9812b782e6781406" },
  safety: { version: 1, cases: 40, sha256: "74d949fbaf5c16d9025a4c25ad8dd980402f990c8b6cffe0670ac75a62f400ae" },
  personas: { version: 1, cases: 13, sha256: "62e3931db9831d1a9300f3e30cda4fe49c97fac0fafc27e76485b695e228d691" },
};

// Older versions kept runnable so results recorded at them still compare.
// They never change.
export const OLDER_PINS: { suite: "letters"; version: 1; cases: number; sha256: string }[] = [
  { suite: "letters", version: 1, cases: 20, sha256: "e303f03b151183f0dcebaf73de4be9bdc942081a0248b23636252b756110c73e" },
];
