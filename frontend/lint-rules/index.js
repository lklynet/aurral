import { noNativeTooltipRules } from "./native-tooltip-rules.js";
import { sharedControlRules } from "./shared-control-rules.js";
import { singleMainRule } from "./single-main-rule.js";
import { noHardCodedStyleColor, noUndefinedStyleToken } from "./ui-style-rules.js";

export default {
  meta: { name: "aurral" },
  rules: {
    "no-hard-coded-style-color": noHardCodedStyleColor,
    "no-undefined-style-token": noUndefinedStyleToken,
    "shared-control-patterns": sharedControlRules,
    "no-native-tooltip": noNativeTooltipRules,
    "single-main": singleMainRule,
  },
};
