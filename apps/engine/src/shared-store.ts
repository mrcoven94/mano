export interface Program {
  id: string;
  name: string;
  officeId: string;
}

export interface OfficeProfile {
  id: string;
  name: string;
  claimed: boolean;
}

export interface SharedStore {
  getProgram(id: string): Promise<Program | null>;
  listPrograms(): Promise<Program[]>;
  getOfficeProfile(id: string): Promise<OfficeProfile | null>;
  putEvalResult(id: string, result: unknown): Promise<void>;
}

export class InMemorySharedStore implements SharedStore {
  private programs = new Map<string, Program>();
  private offices = new Map<string, OfficeProfile>();
  evalResults = new Map<string, unknown>();

  seedProgram(p: Program) {
    this.programs.set(p.id, p);
  }
  seedOffice(o: OfficeProfile) {
    this.offices.set(o.id, o);
  }
  async getProgram(id: string) {
    return this.programs.get(id) ?? null;
  }
  async listPrograms() {
    return [...this.programs.values()];
  }
  async getOfficeProfile(id: string) {
    return this.offices.get(id) ?? null;
  }
  async putEvalResult(id: string, result: unknown) {
    this.evalResults.set(id, result);
  }
}
