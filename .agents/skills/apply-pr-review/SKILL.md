---
name: apply-pr-review
description: Use when the user says to apply a PR review round in Ctrl's review chat, or when a message asks to "Apply round N" of a review. Follows the Apply and Next round sections of the brief that review_session_open returns.
---

# Apply a review round

1. Call `review_session_read`, then `review_session_open` with the session's `url` to get the brief. It returns the live review; it never opens a second one.
2. Follow the brief's "Apply" section, then its "Next round" section.
