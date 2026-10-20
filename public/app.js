(() => {
  const tg = window.Telegram?.WebApp;
  const app = document.querySelector("#app");
  const notice = document.querySelector("#notice");
  const initData = tg?.initData ?? "";
  let current = null;
  let kind = "EXPENSE";
  let editingId = null;
  let noticeTimer;

  tg?.ready();
  tg?.expand();

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initData,
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed.");
    return result;
  }

  function tell(message) {
    notice.textContent = message;
    notice.classList.add("visible");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.remove("visible"), 2600);
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action, className = "") {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function cents(value) {
    const parsed = String(value).trim().replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(parsed))
      throw new Error("Enter a valid amount.");
    const [euros, fraction = ""] = parsed.split(".");
    const result = Number(euros) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(result) || result <= 0 || result > 1_000_000_000)
      throw new Error("Amount must be between 0.01 and 10,000,000.");
    return result;
  }

  function money(value) {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
    }).format(value / 100);
  }

  async function load(ledgerId) {
    if (!initData) throw new Error("Open this app from Telegram.");
    const query = ledgerId ? `?ledgerId=${encodeURIComponent(ledgerId)}` : "";
    current = await request(`/api/state${query}`);
    document.querySelector("#user-name").textContent =
      tg?.initDataUnsafe?.user?.first_name ?? "";
    render();
  }

  function renderPairing() {
    const section = element("section");
    section.append(element("h1", "Start a shared ledger"));
    section.append(
      element(
        "p",
        "Create an invite and share its code with your friend. They join once; then either of you can update the ledger.",
        "muted",
      ),
    );
    section.append(
      button("Create invite", async () => {
        try {
          const invite = await request("/api/invites", {
            method: "POST",
            body: {},
          });
          const code = element("div", invite.code, "invite-code");
          section.replaceChildren(
            element("h1", "Share this invite code"),
            element("p", "Your friend enters this code in the app.", "muted"),
            code,
          );
          section.append(
            button("Copy code", async () => {
              await navigator.clipboard.writeText(invite.code);
              tell("Invite code copied.");
            }),
          );
        } catch (error) {
          tell(error.message);
        }
      }),
    );
    const join = element("section");
    join.append(element("h2", "Join a friend's ledger"));
    const input = element("input");
    input.placeholder = "Invite code";
    input.autocomplete = "off";
    input.value =
      new URLSearchParams(location.search).get("invite") ??
      tg?.initDataUnsafe?.start_param ??
      "";
    const submit = button("Join ledger", async () => {
      try {
        await request("/api/join", {
          method: "POST",
          body: { code: input.value.trim() },
        });
        await load();
        tell("Ledger joined.");
      } catch (error) {
        tell(error.message);
      }
    });
    join.append(input, submit);
    app.replaceChildren(section, join);
  }

  function render() {
    if (!current.ledger) {
      renderPairing();
      return;
    }
    const ledger = current.ledger;
    const fragment = document.createDocumentFragment();
    if (current.ledgers.length > 1) {
      const select = element("select");
      for (const item of current.ledgers) {
        const option = element("option", item.otherName);
        option.value = item.id;
        option.selected = item.id === ledger.id;
        select.append(option);
      }
      select.addEventListener("change", () =>
        load(select.value).catch((error) => tell(error.message)),
      );
      fragment.append(select);
    }
    const balance = element("section", undefined, "balance");
    balance.append(element("span", "Current balance", "muted"));
    const balanceCents = BigInt(ledger.balanceCents);
    balance.append(
      element(
        "strong",
        money(Number(balanceCents < 0n ? -balanceCents : balanceCents)),
      ),
    );
    const other = ledger.a.id === ledger.me ? ledger.b : ledger.a;
    const balanceDescription =
      balanceCents === 0n
        ? "All settled"
        : balanceCents > 0n
          ? `${ledger.b.name} owes ${ledger.a.name}`
          : `${ledger.a.name} owes ${ledger.b.name}`;
    balance.append(element("span", balanceDescription, "muted"));
    balance.append(
      button(
        "Refresh",
        () => load(ledger.id).catch((error) => tell(error.message)),
        "secondary",
      ),
    );
    const inviteSection = element("section");
    inviteSection.append(
      button(
        "Invite friend to this ledger",
        async () => {
          try {
            const invite = await request("/api/invites", {
              method: "POST",
              body: { ledgerId: ledger.id },
            });
            inviteSection.replaceChildren(
              element("h2", "Share this invite code"),
              element("div", invite.code, "invite-code"),
            );
            inviteSection.append(
              button(
                "Copy code",
                async () => {
                  await navigator.clipboard.writeText(invite.code);
                  tell("Invite code copied.");
                },
                "secondary",
              ),
            );
          } catch (error) {
            tell(error.message);
          }
        },
        "secondary",
      ),
    );
    const form = element("section");
    form.append(element("h2", editingId ? "Edit entry" : "Add entry"));
    const tabs = element("div", undefined, "tabs");
    const expenseTab = button("Expense", () => {
      kind = "EXPENSE";
      render();
    });
    const repaymentTab = button("Repayment", () => {
      kind = "SETTLEMENT";
      render();
    });
    expenseTab.disabled = Boolean(editingId);
    repaymentTab.disabled = Boolean(editingId);
    expenseTab.classList.toggle("selected", kind === "EXPENSE");
    repaymentTab.classList.toggle("selected", kind === "SETTLEMENT");
    tabs.append(expenseTab, repaymentTab);
    form.append(tabs);
    const amountInput = element("input");
    amountInput.inputMode = "decimal";
    amountInput.placeholder = "0.00";
    amountInput.value = editingId
      ? (current.entryBeingEdited?.amount / 100).toFixed(2)
      : "";
    const amountLabel = element("label", undefined);
    amountLabel.append(element("span", "Amount (€)"), amountInput);
    form.append(amountLabel);
    const payerSelect = element("select");
    for (const person of [ledger.a, ledger.b]) {
      const option = element(
        "option",
        person.id === ledger.me ? "Me" : person.name,
      );
      option.value = person.id;
      payerSelect.append(option);
    }
    payerSelect.value = ledger.me;
    if (editingId) payerSelect.value = current.entryBeingEdited.payerId;
    const payerLabel = element("label");
    payerLabel.append(element("span", "Paid by"), payerSelect);
    form.append(payerLabel);
    let descriptionInput;
    let percentInput;
    if (kind === "EXPENSE") {
      descriptionInput = element("input");
      descriptionInput.placeholder = "Dinner";
      descriptionInput.maxLength = 120;
      const descriptionLabel = element("label");
      descriptionLabel.append(element("span", "What for?"), descriptionInput);
      percentInput = element("input");
      percentInput.type = "number";
      percentInput.min = "0";
      percentInput.max = "100";
      percentInput.value = "50";
      const percentLabel = element("label");
      percentLabel.append(element("span", "Payer's share (%)"), percentInput);
      if (editingId) {
        descriptionInput.value = current.entryBeingEdited.description;
        const percentageA = current.entryBeingEdited.splitPercentA ?? 50;
        percentInput.value = String(
          current.entryBeingEdited.payerId === ledger.a.id
            ? percentageA
            : 100 - percentageA,
        );
      }
      form.append(descriptionLabel, percentLabel);
    }
    const submit = button(
      editingId ? "Save changes" : "Add to ledger",
      async () => {
        try {
          const body = {
            ledgerId: ledger.id,
            kind,
            amount: cents(amountInput.value),
            payerId: payerSelect.value,
          };
          if (kind === "EXPENSE") {
            body.description = descriptionInput.value.trim();
            body.payerSharePercent = Number(percentInput.value);
          }
          const result = editingId
            ? await request(`/api/entries/${encodeURIComponent(editingId)}`, {
                method: "PATCH",
                body,
              })
            : await request("/api/entries", { method: "POST", body });
          editingId = null;
          current = result;
          render();
          tell("Saved.");
        } catch (error) {
          tell(error.message);
        }
      },
    );
    form.append(submit);
    if (editingId)
      form.append(
        button(
          "Cancel edit",
          () => {
            editingId = null;
            render();
          },
          "secondary",
        ),
      );
    const listSection = element("section");
    listSection.append(element("h2", "Entries"));
    const list = element("div", undefined, "entry-list");
    for (const entry of ledger.entries) {
      const card = element("article", undefined, "entry");
      const payer = entry.payerId === ledger.me ? "Me" : other.name;
      card.append(
        element(
          "span",
          entry.kind === "SETTLEMENT"
            ? `${payer} repaid`
            : `${payer} · ${entry.description}`,
        ),
      );
      card.append(element("strong", money(entry.amount)));
      const details =
        entry.kind === "EXPENSE"
          ? `${money(entry.shareA)} · ${ledger.a.name} / ${money(entry.shareB)} · ${ledger.b.name}`
          : new Date(entry.createdAt).toLocaleDateString();
      card.append(element("small", details));
      const actions = element("div", undefined, "actions");
      if (!entry.reversed) {
        actions.append(
          button(
            "Edit",
            () => {
              editingId = entry.id;
              current.entryBeingEdited = entry;
              kind = entry.kind;
              render();
            },
            "secondary",
          ),
        );
      } else {
        card.append(element("small", "Reversed"));
      }
      actions.append(
        button(
          "Delete",
          async () => {
            try {
              current = await request(
                `/api/entries/${encodeURIComponent(entry.id)}`,
                { method: "DELETE" },
              );
              editingId = null;
              render();
              tell("Deleted.");
            } catch (error) {
              tell(error.message);
            }
          },
          "danger",
        ),
      );
      card.append(actions);
      list.append(card);
    }
    if (!ledger.entries.length)
      list.append(element("p", "No entries yet.", "muted"));
    listSection.append(list);
    fragment.append(balance, inviteSection, form, listSection);
    app.replaceChildren(fragment);
  }

  load().catch((error) => {
    app.replaceChildren(element("section", error.message));
  });
})();
