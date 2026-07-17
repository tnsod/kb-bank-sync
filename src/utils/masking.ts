export function accountIdFromNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/gu, "");
  if (digits.length < 4) {
    throw new Error("Account number must contain at least four digits");
  }
  return `KB-${digits.slice(-4)}`;
}

export function maskAccountNumber(accountNumber: string): string {
  return accountIdFromNumber(accountNumber);
}
