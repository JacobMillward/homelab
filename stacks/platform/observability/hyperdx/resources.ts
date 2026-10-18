import * as pulumi from "@pulumi/pulumi";
import { AlertDef, AlertInputs, AlertOutputs, WebhookInputs, WebhookOutputs, alertProvider, webhookProvider } from "./api";

export interface HyperdxClientArgs {
  endpoint: pulumi.Input<string>;
  apiKey: pulumi.Input<string>;
}

class HyperdxWebhookProvider implements pulumi.dynamic.ResourceProvider<WebhookInputs, WebhookOutputs> {
  create(inputs: WebhookInputs) { return webhookProvider.create(inputs); }
  update(id: string, olds: WebhookOutputs, news: WebhookInputs) { return webhookProvider.update(id, olds, news); }
  delete(id: string, outs: WebhookOutputs) { return webhookProvider.delete(id, outs); }
}

class HyperdxAlertProvider implements pulumi.dynamic.ResourceProvider<AlertInputs, AlertOutputs> {
  create(inputs: AlertInputs) { return alertProvider.create(inputs); }
  update(id: string, olds: AlertOutputs, news: AlertInputs) { return alertProvider.update(id, olds, news); }
  delete(id: string, outs: AlertOutputs) { return alertProvider.delete(id, outs); }
}

export class HyperdxWebhook extends pulumi.dynamic.Resource {
  public readonly webhookId!: pulumi.Output<string>;

  constructor(name: string, args: { client: HyperdxClientArgs; name: string; url: pulumi.Input<string>; token: pulumi.Input<string>; topic: string }, opts?: pulumi.CustomResourceOptions) {
    super(new HyperdxWebhookProvider(), name, { ...args, webhookId: undefined }, {
      ...opts,
      additionalSecretOutputs: ["client", "token"],
    });
  }
}

export class HyperdxAlert extends pulumi.dynamic.Resource {
  constructor(name: string, args: { client: HyperdxClientArgs; def: AlertDef; webhookId: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
    super(new HyperdxAlertProvider(), name, { ...args, alertId: undefined }, {
      ...opts,
      additionalSecretOutputs: ["client"],
    });
  }
}
