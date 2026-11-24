export function cameraId(make: string | undefined, model: string | undefined): string | null {
  const part = (value: string | undefined): string | null => {
    const slug = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    return slug === "" ? null : slug;
  };
  const [maker, named] = [part(make), part(model)];
  return maker === null || named === null ? null : `${maker}/${named}`;
}

export function isCameraId(text: string): boolean {
  return /^[a-z0-9-]+\/[a-z0-9-]+$/u.test(text);
}
