Below is one long message a person sent to an AI assistant, kept in their private archive. Long messages are usually a few lines the person typed around a large paste: code, logs, an email, a document. Some are all typing, some all paste. Attached files follow the message, each with the text the assistant was given.

Reply with one JSON object and nothing else:

{"own": ["..."], "pasted": "...", "attachments": ["..."]}

- "own": the words the person wrote themself, copied exactly, character for character, as one or more excerpts in the order they appear. Copy; never fix, shorten inside an excerpt, translate or summarise. Leave out pasted material. Use [] when the message is all paste.
- "pasted": one line saying what was pasted, specific enough to recognise it later (for example "a Python traceback from a Django test run", "a draft cover letter for a design job"). Use "" when nothing was pasted.
- "attachments": one line per attached file, in order, saying what it is and what it is about. Use [] when there are none.

{PLACEHOLDERS}

Never copy a password, key, token, one-time code or full account number into any line; name the kind of thing instead.
