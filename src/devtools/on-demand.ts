/**
 * The kernel (0.5.6+) looks for this module by name: its presence says this framework's `devtools` folder can stay off
 * the shared client tree, because runtime/devtools-loader.ts hands each dev a copy. Older frameworks don't have it, and
 * keep the folder where their static imports need it.
 */
export const DEVTOOLS_ON_DEMAND = true;
