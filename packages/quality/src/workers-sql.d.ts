// The judge run (spine.ts) imports Engine's replay page, whose module names
// the Workers runtime's SqlStorage type through Engine's SQL store. The run
// renders the page only and never opens that store, so the type is left open.
type SqlStorage = any;
