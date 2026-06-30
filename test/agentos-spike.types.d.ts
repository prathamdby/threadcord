declare module "@agentos-software/pi" {
  const pi: any;
  export default pi;
}

declare module "@rivet-dev/agentos-sidecar" {
  export function getSidecarPath(): Promise<string>;
}
