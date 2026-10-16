# Decisions: chore/windows-setup

- **Develop natively on Windows; keep the corpus in Git objects, off disk.** Per-repo `core.protectNTFS false` plus a non-cone sparse checkout excluding `/corpus/`. Alternatives: WSL or Docker (works, but extra setup and doesn't make the deliverable portable); `protectNTFS false` with a full checkout (Windows writes `1.` as `1`, Git then shows 6,480 changes and a commit would rename the corpus); renaming the corpus (citations would no longer match the reviewer's raw files). Won because corpus bytes and paths stay untouched and the same approach works for a Windows reviewer.
- **A message's identity is its exact Git path, trailing dot included** (`corpus/farmer-d/logistics/1.`). The reviewer checks citations against raw files, so the ID must be the name they see.
- **One corpus reader with two sources (disk or `git cat-file --batch`), byte-identical by test.** Alternative: a renamed on-disk mirror as the source of truth; rejected because Windows and macOS/Linux would then cite different names.
- **`corpus-view/` export with `.eml` names, git-ignored, for humans only.** Lets us browse on Windows without it ever becoming a citation source.
- **`.gitattributes`: `corpus/** -text`.** 3,231 of 3,240 messages contain CRLF and Git for Windows here defaults to `core.autocrlf=true`; pinning the bytes keeps hashes and verbatim quotes identical across OSes.
- **Prove portability with a CI matrix (Ubuntu, macOS, Windows) on the model-free tests**, rather than owning Mac/Linux machines. Deferred to when the tests exist.
