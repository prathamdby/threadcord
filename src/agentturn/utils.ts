export function hashInstruction(instruction: string): string {
  let h = 0;
  for (let i = 0; i < instruction.length; i++) {
    h = ((h << 5) - h + instruction.charCodeAt(i)) | 0;
  }
  return `hash-${Math.abs(h).toString(16)}`;
}
