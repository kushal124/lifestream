import type { Recipe } from "@lifestreamprotocol/connect/sdk";

export const whoopSignInRecipe: Recipe = {
  name: "whoop-sign-in",
  version: 1,
  site: "WHOOP",
  origins: ["https://id.whoop.com", "https://app.whoop.com"],
  params: ["email", "password"],
  secrets: ["${password}"],
  steps: [
    { id: "email", do: "fill", target: { role: "textbox", name: "Email" }, text: "${email}", expect: { role: "heading", name: "Sign In" } },
    { id: "password", do: "fill", target: { role: "textbox", name: "Password" }, secret: "${password}" },
    { id: "sign-in", do: "click", target: { role: "button", name: "Sign In", exact: true }, acts: true, then: { url: "^https://app\\.whoop\\.com/" } },
  ],
};

export const recipes: Readonly<Record<string, Recipe>> = { [whoopSignInRecipe.name]: whoopSignInRecipe };
