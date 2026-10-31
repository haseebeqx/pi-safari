import { createSafariExtension } from './index.ts';

/**
 * Entry point of @haseebeqx/pi-safari-unrestricted. Every session starts with full restricted-action
 * permission and JavaScript evaluation already granted, in every Pi mode (interactive, print,
 * JSON and RPC). Safari settings, URL/target validation and tool limits still apply.
 */
export default createSafariExtension({ fullActions: true, evaluate: true, noninteractive: true });
