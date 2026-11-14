import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@shared/lib/test-utils";

// ---------------------------------------------------------------------------
// Mock useReopenTab — ReopenTabDialog imports it directly from
// '../model/useReopenTab' (not the feature barrel), so the mock specifier
// must match that exact module (the same mock-path bug fixed in
// RegisterCajaEntryDialog.test.tsx during F3 round 1 — mocking the barrel
// here would silently never intercept ReopenTabDialog's own import).
// ---------------------------------------------------------------------------

const mockMutateAsync = vi.fn();
const mockResetIdempotencyKey = vi.fn();

vi.mock("../model/useReopenTab", () => ({
  useReopenTab: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    resetIdempotencyKey: mockResetIdempotencyKey,
  }),
}));

vi.mock("@entities/tab", () => ({
  useTab: () => ({ data: { id: "tab-uuid-001", customerName: "Test Customer", version: 1 } }),
  tabKeys: { detail: (id: string) => ["tabs", "detail", id] },
}));

vi.mock("@features/manager-pin-gate", () => ({
  ManagerPinDialog: () => null,
}));

import { ReopenTabDialog } from "./ReopenTabDialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <ReopenTabDialog open={open} tabId="tab-uuid-001" onOpenChange={onOpenChange} />
  );
  return { onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReopenTabDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the sheet heading when open", () => {
    renderDialog();
    expect(screen.getByText("Reopen ticket")).toBeInTheDocument();
  });

  it("discards the idempotency key when the sheet is closed via Cancel (fix-pass F4: ReopenTabDialog stays mounted across different tabs)", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
