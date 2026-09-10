export type OperationCategory =
  | "file"
  | "index"
  | "guidance"
  | "reference"
  | "link"
  | "skill"
  | "executor"
  | "bookkeeping";

export type OperationAction = "write" | "remove" | "link" | "reconcile" | "snapshot";

export type OperationStatus =
  | "created"
  | "updated"
  | "removed"
  | "linked"
  | "relinked"
  | "planned"
  | "unchanged"
  | "skipped"
  | "blocked"
  | "failed";

export type OperationChange = "content" | "permissions" | "path-type" | "destination" | "revision";

export type PlannedOperationEffect = "add" | "update" | "remove";

export interface OperationOutcome {
  category: OperationCategory;
  action: OperationAction;
  status: OperationStatus;
  target: string;
  significance: "meaningful" | "internal";
  plannedEffect?: PlannedOperationEffect;
  changes?: readonly OperationChange[];
  before?: string;
  after?: string;
  detail?: string;
}

export type OperationStart = Pick<OperationOutcome, "category" | "action" | "target"> & {
  detail?: string;
};

export type OperationStartNotification = (operation: OperationStart) => void;
export type OperationCompletion = (outcome: OperationOutcome) => void;

export interface OperationCollector {
  readonly outcomes: OperationOutcome[];
  complete: OperationCompletion;
}

export function collectOperations(onComplete?: OperationCompletion): OperationCollector {
  const outcomes: OperationOutcome[] = [];
  return {
    outcomes,
    complete(outcome) {
      outcomes.push(outcome);
      onComplete?.(outcome);
    }
  };
}

export function operationChanged(outcome: OperationOutcome): boolean {
  return ["created", "updated", "removed", "linked", "relinked"].includes(outcome.status);
}
