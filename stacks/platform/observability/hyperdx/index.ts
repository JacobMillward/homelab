import * as pulumi from "@pulumi/pulumi";
import { ALERTS } from "./api";
import { HyperdxAlert, HyperdxWebhook } from "./resources";

export interface HyperdxConfigArgs {
  endpoint: pulumi.Input<string>;
  apiKey: pulumi.Input<string>;
  webhookUrl: pulumi.Input<string>;
  webhookToken: pulumi.Input<string>;
  topic: string;
}

export class HyperdxConfig extends pulumi.ComponentResource {
  constructor(name: string, args: HyperdxConfigArgs, opts?: pulumi.ComponentResourceOptions) {
    super("platform:observability:HyperdxConfig", name, {}, opts);
    const childOpts = { parent: this };
    const client = { endpoint: args.endpoint, apiKey: pulumi.secret(args.apiKey) };

    const webhook = new HyperdxWebhook(
      "ntfy-webhook",
      { client, name: "ntfy", url: args.webhookUrl, token: args.webhookToken, topic: args.topic },
      childOpts,
    );

    for (const def of ALERTS) {
      new HyperdxAlert(
        `alert-${def.id}`,
        { client, def, webhookId: webhook.webhookId },
        childOpts,
      );
    }
  }
}
