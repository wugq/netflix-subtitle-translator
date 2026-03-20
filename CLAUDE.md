# Code Style

## Comments

**Never write "what" comments.** Code should be self-explanatory. If a comment only restates what the code does, remove it or rewrite the code to be clearer instead.

```js
// Bad — what comment (restates the code)
// Increment the counter
count++;

// Bad — what comment
// Inject injected.js into page context
const script = document.createElement('script');
```

**Only write "why" comments** — explaining non-obvious decisions, constraints, browser quirks, or historical context that cannot be expressed in the code itself.

```js
// Good — why comment (explains a non-obvious browser constraint)
// Chrome MV3: returning a Promise does not keep the port open.
// Must return true synchronously and call sendResponse when done.
result.then(sendResponse);
return true;

// Good — why comment (explains a timing edge case)
// Netflix fires the next video's manifest before the URL changes,
// so we must not let a later manifest overwrite an earlier one we still need.
```

**When in doubt, prefer clearer naming over a comment.** Rename the variable or extract a well-named function rather than explaining it with a comment.
