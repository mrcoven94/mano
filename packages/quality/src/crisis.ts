// One crisis detector shared by the bench and the live hooks. The live path
// runs it over the resident's inbound message; the bench test runs it over
// every crisis fixture turn (must fire) and every look-alike (must not).
// Deliberately narrow: deadline and device look-alikes must not trigger it.

export const CRISIS_SIGNAL_RES: RegExp[] = [
  /hurt (myself|yourself)/i,
  /kill (myself|yourself)/i,
  /end my (life|it)/i,
  /(don't|do not) want to (be here|live|be alive)/i,
  /want to die/i,
  /\bsuicid/i,
  /better off without me/i,
  /took (some|too many|a lot of|a handful of) (pills|tablets|medication)/i,
  /\boverdose?\b/i,
  /swallowed .{0,30}(pills|tablets|medication|bottle)/i,
  /hacerme daño/i,
  /quitarme la vida/i,
  /quiero morir/i,
  /no quiero (seguir|vivir)/i,
  /tomé (demasiadas|muchas|un puñado de) (pastillas|píldoras)/i,
];

export function needsCrisisResponse(text: string | undefined): boolean {
  if (!text) return false;
  return CRISIS_SIGNAL_RES.some((re) => re.test(text));
}
