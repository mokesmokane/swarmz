import qrcode from "qrcode-generator";
import type { HostKeys } from "./ipc";

/**
 * The pairing URI the phone reads from the QR code (spec §7.2):
 * `swarmz://pair?host=<magicdns-name>&user=<unix-user>&fp=<SHA256:…>&…&v=1`.
 *
 * It carries no secret — ssh host keys are public — so a photograph of the code gives nobody
 * access; the Mac's password is still needed. Every host key the Mac offers goes in as its own
 * `fp`, so a phone that negotiates a different key type than we guessed still matches a pin.
 *
 * Every value is percent-encoded, so no value can add a parameter of its own.
 */
export function pairUri({ host, user, fingerprints }: HostKeys): string {
  const params = [
    `host=${encodeURIComponent(host)}`,
    `user=${encodeURIComponent(user)}`,
    ...fingerprints.map((fp) => `fp=${encodeURIComponent(fp)}`),
    "v=1",
  ];
  return `swarmz://pair?${params.join("&")}`;
}

/**
 * `text` as an `<svg>` string, scalable so the box it is put in decides how big it is drawn.
 * Error correction level M: the code is read off a screen at arm's length, not off paper.
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 1, margin: 2, scalable: true });
}
