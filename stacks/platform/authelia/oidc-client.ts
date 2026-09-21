import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export interface OidcClientArgs {
  redirectUris: pulumi.Input<string>[];
  scopes?: string[];
  authorizationPolicy?: string;
  userinfoSignedResponseAlg?: string;
}

export interface OidcClientSpec {
  clientId: pulumi.Output<string>;
  clientSecret: pulumi.Output<string>;
  clientName: string;
  redirectUris: pulumi.Input<string>[];
  scopes: string[];
  authorizationPolicy: string;
  userinfoSignedResponseAlg?: string;
}

/**
 * Generates a client_id/client_secret pair for an Authelia OIDC client.
 * The caller (e.g. NetBird or Forgejo) owns the resulting resources in
 * Pulumi state; Authelia only renders whatever list of specs it's handed.
 */
export function createOidcClient(
  name: string,
  args: OidcClientArgs,
): OidcClientSpec {
  const clientId = new random.RandomPassword(`${name}-oidc-client-id`, {
    length: 32,
    special: false,
  });
  const clientSecret = new random.RandomPassword(`${name}-oidc-client-secret`, {
    length: 64,
    special: false,
  });

  return {
    clientId: clientId.result,
    clientSecret: clientSecret.result,
    clientName: name,
    redirectUris: args.redirectUris,
    scopes: args.scopes ?? ["openid", "profile", "email"],
    authorizationPolicy: args.authorizationPolicy ?? "one_factor",
    userinfoSignedResponseAlg: args.userinfoSignedResponseAlg,
  };
}
