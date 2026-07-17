export interface RawKbTransaction {
  dateText: string;
  timeText: string;
  transactionTypeText: string;
  descriptionText: string;
  memoText: string;
  withdrawalText: string;
  depositText: string;
  balanceText: string;
  branchText: string;
}

export interface Transaction {
  sourceKey: string;
  bank: "KB";
  accountId: string;
  occurredAt: string;
  transactionType: string | null;
  description: string;
  memo: string | null;
  withdrawal: number;
  deposit: number;
  balance: number | null;
  branch: string | null;
  collectedAt: string;
}

export type TransactionWithoutSourceKey = Omit<Transaction, "sourceKey">;
