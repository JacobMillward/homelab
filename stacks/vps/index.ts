import { VpsServer } from "./server";

const vps = new VpsServer();

export const vpsIp = vps.ipv4Address;
export const vpsWgPublicKey = vps.vpsWgPublicKey;
export const homeWgPrivateKey = vps.homeWgPrivateKey;
export const homeWgPublicKey = vps.homeWgPublicKey;
export const relayAuthSecret = vps.relayAuthSecret;
export const relayAddress = vps.relayAddress;
export const stunAddress = vps.stunAddress;

