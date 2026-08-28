import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Disclosure, Switch, ToggleButton, ToggleButtonGroup } from "@heroui/react";

import { createReporter } from "../harness.mjs";

/**
 * That the panel's controls are still controls, and not pictures of controls.
 *
 * This suite exists because of a dependency bump. HeroUI 3.2 split `Switch` in
 * two: the root became React Aria's `SwitchField`, a `<div>` carrying state,
 * and the `<label>` holding the hidden checkbox moved into `Switch.Content`.
 * Children written directly under the root — the 3.0 spelling — kept rendering,
 * kept their classes, and kept looking exactly right. They were simply outside
 * the label, so every toggle in the panel became scenery: eight settings that
 * could be clicked at and never changed, with no error anywhere because no
 * handler ever ran.
 *
 * Nothing caught it. TypeScript could not: `children` is `ReactNode` and the
 * old spelling still typechecks. The build could not: it compiles. A screenshot
 * could not: it is pixel-identical. The only thing that separates a working
 * control from a dead one is whether the rendered markup still contains the
 * element a click can land on — so that is what this asserts, on the primitives
 * the panel's wrappers are built from.
 *
 * Rendered with `react-dom/server` rather than driven in a browser on purpose:
 * the question here is not "does the click work", it is "is there anything to
 * click", and that is answerable from static markup in milliseconds.
 */
export const meta = { name: "ui-controls-unit", needsDocker: false, drivers: [], standalone: true };

const h = React.createElement;

/** The interactive element, wherever the library decided to put it. */
const hasCheckbox = (html) => /<input[^>]*type="checkbox"/.test(html);
const hasButton = (html) => /<button/.test(html);

export async function run() {
  const r = createReporter("ui-controls-unit");

  // --- Switch, spelled the way components/ui/SettingToggle.tsx spells it ----
  const toggle = renderToStaticMarkup(
    h(
      Switch,
      { isSelected: true, onChange: () => {}, className: "w-full" },
      h(
        Switch.Content,
        { className: "flex w-full items-start justify-between gap-3" },
        h("span", { className: "min-w-0 flex-1" }, "Attiva auto-deploy"),
        h(Switch.Control, null, h(Switch.Thumb, null))
      )
    )
  );

  r.check("switch renders a checkbox a click can reach", hasCheckbox(toggle), toggle);
  r.check("switch announces itself as a switch", /role="switch"/.test(toggle));
  r.check("switch reflects the selected state", /<input[^>]*checked/.test(toggle));
  r.check(
    "the checkbox sits inside Switch.Content",
    toggle.indexOf('data-slot="switch-content"') < toggle.indexOf("<input"),
    toggle
  );
  r.check(
    "the thumb is still drawn",
    /data-slot="switch-thumb"/.test(toggle) && /data-slot="switch-control"/.test(toggle)
  );

  /*
    The regression itself, pinned as a fact rather than a memory: children under
    the root alone produce a switch with no input at all. If a future version
    makes this spelling work again the check fails, which is the right kind of
    failure — it means the shape of the component moved again and the wrapper
    should be looked at.
  */
  const inert = renderToStaticMarkup(
    h(
      Switch,
      { isSelected: true, onChange: () => {} },
      h("span", null, "Attiva auto-deploy"),
      h(Switch.Control, null, h(Switch.Thumb, null))
    )
  );
  r.check("a switch without Switch.Content has nothing to click", !hasCheckbox(inert), inert);

  // --- Segmented, from components/ui/Segmented.tsx --------------------------
  const segmented = renderToStaticMarkup(
    h(
      ToggleButtonGroup,
      { selectionMode: "single", selectedKeys: ["a"], onSelectionChange: () => {} },
      h(ToggleButton, { id: "a" }, "Uno"),
      h(ToggleButton, { id: "b" }, "Due")
    )
  );
  r.check("segmented options render as buttons", hasButton(segmented), segmented);
  r.check("the selected option is marked", /data-selected="true"/.test(segmented));

  // --- Button --------------------------------------------------------------
  const button = renderToStaticMarkup(h(Button, { onPress: () => {} }, "Salva"));
  r.check("button renders a <button>", hasButton(button), button);
  r.check("button is pressable", /data-react-aria-pressable/.test(button), button);

  // --- Section header, from components/ui/Section.tsx -----------------------
  const section = renderToStaticMarkup(
    h(
      Disclosure,
      null,
      h(Disclosure.Heading, null, h(Disclosure.Trigger, null, "Deploy automatico")),
      h(Disclosure.Content, null, "corpo")
    )
  );
  r.check("disclosure renders a trigger button", hasButton(section), section);

  return r.result();
}
