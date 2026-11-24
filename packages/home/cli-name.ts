export const CLI = "lifestream";

export const typed = (path: string): string => (/^(?!=)[\w./~@:+=-]+$/u.test(path) ? path : `"${path.replace(/(["\\$`])/gu, "\\$1")}"`);
