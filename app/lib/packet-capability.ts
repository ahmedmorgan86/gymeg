/** Fail closed: a packet that left collections out is only usable by a client built to derive them on demand (strict lazy loading AND the explicit omit capability). Any other client must refuse it, never render the empty list as data. */
export const packetUsable=(p:{omitted?:readonly string[]}|null|undefined,capable:boolean)=>!p?.omitted?.length||capable;
/** The capability header is sent only by a capable build (default OFF), so partial flags and old builds always get the full packet. */
export const lazyHeaders=(capable:boolean):Record<string,string>=>capable?{'X-GymOS-Lazy':'1'}:{};
