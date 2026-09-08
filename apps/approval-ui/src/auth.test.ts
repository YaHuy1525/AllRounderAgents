import { describe, expect, it } from "vitest";

import { chooseSignInMethod, signInStatusMessage } from "./auth.js";

describe("sign-in method", () => {
  it("prefers a one-time code over a leftover password", () => {
    expect(chooseSignInMethod({ password: "secret", otp: "123456" })).toBe("otp");
    expect(chooseSignInMethod({ password: "secret", otp: "" })).toBe("password");
    expect(chooseSignInMethod({ password: "", otp: "123456" })).toBe("otp");
    expect(chooseSignInMethod({ password: "  ", otp: "" })).toBe("magiclink");
  });
});

describe("sign-in status copy", () => {
  it("tells the user to use a password instead of sending another email", () => {
    expect(signInStatusMessage("magiclink", null)).toContain("password");
    expect(signInStatusMessage("magiclink", null)).not.toContain("Check your email");
    expect(
      signInStatusMessage("magiclink", {
        code: "over_email_send_rate_limit",
        message: "email rate limit exceeded",
      }),
    ).toContain("password");
  });
});
