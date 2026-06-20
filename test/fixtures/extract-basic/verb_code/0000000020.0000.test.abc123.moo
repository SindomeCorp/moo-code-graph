"comment using the valid comment syntax for tree-sitter-moo";
THIS:test();
this:match();
this:wi();
this:missing();
`this:optional_e_verbnf() ! E_VERBNF';
`this:optional_any() ! ANY';
`this:optional_default(@args) ! ANY => 0';
this:render();
player:tell("Done");
$String_Utils:trim(foo);
$missing:noop();
#30:notify(player);
#30:sh();
#40:local();
#40:match();
#40:wi();
#50:missing();
#999:notify(player);
obj:foo(1, 2, 3);
obj:(verb_name)(args);
local_obj = #30;
local_obj:notify(player);
local_core = $STRING_UTILS;
LOCAL_CORE:trim(foo);
local_this = THIS;
local_this.foo;
this_verb_alias_value = this.(verb);
perms = caller_perms();
perms.wizard;
caller_perms().programmer;
valid_guard_value = valid(valid_target) ? valid_target.name | "invalid";
if (valid(valid_branch))
  valid_branch.name;
endif
if (!valid(valid_exit))
  return;
endif
valid_exit.owner;
recycler_guard_value = $recycler:valid(recycler_target) ? recycler_target.name | "invalid";
if ($recycler:valid(recycler_branch))
  recycler_branch.name;
endif
if (!$recycler:valid(recycler_exit))
  return;
endif
recycler_exit.owner;
if (!$command_utils:object_match_failed(match_branch, dobjstr))
  match_branch.name;
endif
if ($command_utils:object_match_failed(match_exit, dobjstr))
  return;
endif
match_exit.owner;
if ($command_utils:player_match_failed(match_assigned = player:my_match_object("wizard"), "wizard"))
  return;
endif
match_assigned.name;
local_location = local_obj.location;
local_location:local();
local_location.shared;
local_obj.location.owner;
{destructured_obj, destructured_name} = args;
destructured_obj.name;
for item in local_obj.contents
  item.name;
endfor
for list_item in (local_obj.items)
  list_item:local();
  list_item.shared;
endfor
for refined_item in (local_obj.items)
  if ($ou:isa(refined_item, #30))
    refined_item:boosted();
  endif
endfor
for child_item in children(local_obj)
  child_item:local();
endfor
ambiguous = #30;
ambiguous = #40;
ambiguous.shared;
overwritten = #30;
overwritten = args[1];
overwritten.name;
if (flag)
  branch_obj = #30;
else
  branch_obj = #40;
endif
branch_obj.shared;
if (flag)
  branch_unknown = #30;
else
  branch_unknown = args[2];
endif
branch_unknown.name;
if ($ou:isa(x, $freq_booster) && x.powered)
  freq_value = freq_value + x.interference_modifier;
  x:boosted();
endif
for phone_holder in (local_obj.items)
  if (`$ou:isa(phone_holder.phone, $freq_booster) ! ANY => 0')
    phone_holder.phone.interference_modifier;
  endif
endfor
root_props_seen = {};
for root_prop in (properties(#0))
  root_prop_value = #0.(root_prop);
endfor
cond_guard_value = $object_utils:has_property(this, "namec") ? this.namec | fallback;
if ($ou:has_property(runtime_hp, "p"))
  runtime_hp.p;
endif
if (!$ou:has_property(exit_hp, "p"))
  return;
endif
exit_hp.p;
if ($ou:has_property(this, "foo"))
  this.foo;
endif
dyn_name = "p";
if ($ou:has_property(dyn_hp, dyn_name))
  dyn_hp.p;
endif
if ($ou:has_property(mismatch_hp, "p"))
  mismatch_hp.q;
endif
if ($ou:has_property(outside_hp, "p"))
endif
outside_hp.p;
if ($ou:has_callable_verb(runtime_callable, "boosted"))
  runtime_callable:boosted();
endif
callable_cond = $object_utils:has_verb(runtime_cond, "boosted") ? runtime_cond:boosted() | 0;
if (!$ou:has_callable_verb(exit_callable, "boosted"))
  return;
endif
exit_callable:boosted();
if ($ou:has_callable_verb(local_obj, "local"))
  local_obj:local();
endif
callable_name = "boosted";
if ($ou:has_callable_verb(dynamic_callable, callable_name))
  dynamic_callable:boosted();
endif
if ($ou:has_callable_verb(mismatch_callable, "boosted"))
  mismatch_callable:other();
endif
if ($ou:has_callable_verb(outside_callable, "boosted"))
endif
outside_callable:boosted();
if ($object_utils:isa(y, $freq_booster))
  y.interference_modifier;
endif
if (isa(z, #40))
  z.interference_modifier;
endif
if (isa(no_else, #40))
else
  no_else.interference_modifier;
endif
if (isa(no_or, #40) || flag)
  no_or.interference_modifier;
endif
post_guard.interference_modifier;
if (isa(post_guard, #40))
endif
post_guard.interference_modifier;
{guarded_player, ignored_guard} = args;
if (!$ou:isa(guarded_player, $player))
  return 0;
elseif (`guarded_player.location ! ANY => ""')
  guarded_player:boosted();
endif
guarded_player.location;
x = this.foo;
this.foo = x;
y = this.inherited;
core_value = $string_utils.coreprop;
shared_value = #40.shared;
built_in_name = this.name;
missing_prop = this.missing_prop;
missing_prop_caught = `this.missing_prop ! E_PROPNF => 0';
missing_object_prop = #999.foo;
unsupported_prop = player.name;
runtime_prop = dobj.name;
y = obj.(prop_name);
obj.(prop_name) = y;
z = #30;
result = tostr(#30);
nothing = #-1;
ambiguous_match = #-2;
failed_match = #-3;
unknown_negative = #-4;
$root_status = time();
uptime = $root_status;
$critical("fixture warning");
$missing_root_verb("bad");
maxobjhack = `$bf_max_object() ! E_VERBNF => #-1';
