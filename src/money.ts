export type MoneyKind = "EXPENSE" | "SETTLEMENT";
export const MAX_CENTS = 1_000_000_000;
export function parseQuery(query: string): {
  kind: MoneyKind;
  amount: number;
  description: string;
} {
  const settlement = /^ausgleich\s+/i.test(query.trim());
  const text = query.trim().replace(/^ausgleich\s+/i, "");
  const match =
    /^(\d{1,8})(?:[,.](\d{1,2}))?\s*(?:€|EUR\b)?(?:\s+(.+))?$/i.exec(text);
  if (!match) throw new Error("Betrag ungültig. Beispiel: 12,50 Essen");
  const amount =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CENTS)
    throw new Error("Betrag muss zwischen 0,01 und 10.000.000 EUR liegen.");
  const description = match[3]?.trim();
  if ((settlement && description) || (!settlement && !description))
    throw new Error("Beispiel: 12,50 Essen oder ausgleich 12");
  if (
    description &&
    (description.length > 120 || /[\p{Cc}\p{Cf}]/u.test(description))
  )
    throw new Error("Beschreibung: maximal 120 Zeichen, keine Steuerzeichen.");
  return {
    kind: settlement ? "SETTLEMENT" : "EXPENSE",
    amount,
    description: description ?? "Ausgleich",
  };
}
export function split(amount: number, payerIsA: boolean): [number, number] {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CENTS)
    throw new Error("Ungültiger Centbetrag");
  const other = Math.floor(amount / 2);
  return payerIsA ? [amount - other, other] : [other, amount - other];
}
/** Positive = B owes A. BigInt avoids cumulative Number precision loss. */
export function delta(
  kind: MoneyKind,
  amount: number,
  payerIsA: boolean,
): bigint {
  const [a, b] = split(amount, payerIsA);
  return kind === "EXPENSE"
    ? BigInt(payerIsA ? b : -a)
    : BigInt(payerIsA ? amount : -amount);
}
export function euro(cents: number | bigint): string {
  const n = BigInt(cents),
    abs = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${abs / 100n},${String(abs % 100n).padStart(2, "0")} €`;
}
