// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ExperienceReviewPanel } from "./experience-review-panel";

afterEach(cleanup);

describe("ExperienceReviewPanel", () => {
  test("requires a reason before an administrator review action", () => {
    const onReview = vi.fn();
    render(<ExperienceReviewPanel role="admin" items={[{
      id: "review-1", patternGroupId: "experience-1", priority: "high",
      kind: "trusted_negative_outcome", taskSummary: "signed_ci failed",
      feedbackEvent: null, createdAt: "2026-07-22T00:00:00Z"
    }]} onReview={onReview} />);

    expect(screen.getByRole("button", { name: "推荐" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("审核理由"), { target: { value: "引用与条件已复核" } });
    fireEvent.click(screen.getByRole("button", { name: "推荐" }));
    expect(onReview).toHaveBeenCalledWith("experience-1", "recommend", "引用与条件已复核");
  });

  test("does not render mutation controls for members", () => {
    render(<ExperienceReviewPanel role="member" items={[]} onReview={vi.fn()} />);
    expect(screen.queryByLabelText("审核理由")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "推荐" })).not.toBeInTheDocument();
  });
});
