// Committed suite pins. A changed case changes the hash; the pins test then
// fails until the author bumps the suite version and re-pins on purpose.
// Never loosen or delete a case to let a model pass.

export const SUITE_PINS: Record<string, { version: number; cases: number; sha256: string }> = {
  chat: { version: 1, cases: 40, sha256: "8aa71d182f91fc651efa154a7abe651e672d231d537c18b6e1a553b5076c652b" },
  text: { version: 1, cases: 25, sha256: "8791e23f793b43e45d3ef7df6a0cf756e9064e833dd0b313733f7ac588509faf" },
  letters: { version: 1, cases: 20, sha256: "e303f03b151183f0dcebaf73de4be9bdc942081a0248b23636252b756110c73e" },
  safety: { version: 1, cases: 40, sha256: "74d949fbaf5c16d9025a4c25ad8dd980402f990c8b6cffe0670ac75a62f400ae" },
};
