// Words that carry an action's meaning: the small words of English and
// Spanish, the words of benefits tasks and forms, and the words an
// instruction to Mano or to Guardian is made of. A person's own value can
// contain one (a street named Food Benefits Renewal Road, a city named
// Union), but such a word never matches on its own, so it is never
// removed from the purpose or from an instruction Guardian has to read.
// A value Mano has not confirmed with the person counts as its kind only
// when it has none of these words, so a document cannot turn an
// instruction into a name. Written folded: lower case, no accents.

const FUNCTION_WORDS = `
a an the and or but nor of to in on at by for from with without into onto about above below over under
after before between through during until since as if then than so not no yes all any each every some
none both either neither this that these those it its me my mine we us our ours you your yours he him
his she her hers they them their theirs who whom whose which what when where why how is are was were be
been being am do does did doing done have has had having will would shall should can could may might
must here there now just only also too very more most less least other another same such own up down
out off again once still even ever never always already yet please thanks thank hello hi dear re fwd
`;

const INSTRUCTION_WORDS = `
ignore ignored ignoring disregard forget override overrides overridden bypass skip skipped previous prior
earlier instruction instructions rule rules policy policies prompt prompts system assistant model checker
guardian safety check checks checked checking verdict pass passed passes approve approves approved
approval allow allows allowed permit permitted authorized authorize authorise trusted trust safe valid
verified verify confirm confirmed return returns respond reply answer output print say tell act pretend
role mode admin administrator developer debug test testing urgent immediately asap required require send
sends sent sending forward forwarded copy copies cc bcc share shared sharing upload post mail mailed email
emails emailed message messages text texts call fax transfer pay paid payment wire deposit submit
submitted attach attached include add remove delete change update replace set use open click visit go
link links site website page account password login code key secret data details information info file
files document documents letter letters form forms field fields block blocked fix fixed stop continue
proceed execute run make get give take keep hide hidden reveal leak everything nothing anything something
everyone someone anyone instead real actual true false null ok okay complete completed task action
actions request requests recipient recipients destination new note notes important attention
`;

const TASK_WORDS = `
food foods benefit benefits renewal renewals renew renewing application applications apply applying
applicant recertification recertify review interview appointment deadline notice case caseworker worker
office agency program programs snap wic tanf medicaid medicare chip health coverage insurance cash
assistance aid help support child children care childcare housing rent rental voucher section utility
utilities energy heating income wages wage earnings paystub stub job employer employment work household
family member members person people name names full first last middle legal birth date dob phone number
mailing address residence home portal sandbox online monthly weekly yearly annual amount dollars total
size proof verification eligibility eligible qualify denied denial appeal hearing report changes status
balance card ebt school lunch meals senior disability ssi ssdi social security unemployment tax taxes
refund credit day month year today tomorrow week
`;

const SPANISH_WORDS = `
el la los las un una unos unas y o de del al en con sin por para que se su sus mi mis tu tus es son
este esta esto ese esa eso todo todos toda todas si ya ahora mas ignora ignorar ignoren olvida olvidar
regla reglas instruccion instrucciones anterior anteriores envia enviar envie manda mandar copia copias
aprueba aprobar aprobado devuelve responde correo beneficios beneficio comida alimentos renovacion
solicitud formulario cita entrevista oficina hogar ingresos familia nombre fecha nacimiento telefono
direccion vivienda renta salud seguro cuidado ninos ayuda programa estado caso
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(
  [FUNCTION_WORDS, INSTRUCTION_WORDS, TASK_WORDS, SPANISH_WORDS].join(" ").split(/\s+/).filter(Boolean),
);
