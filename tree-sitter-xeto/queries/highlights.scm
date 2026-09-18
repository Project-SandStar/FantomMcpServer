; highlights.scm — Xeto syntax highlighting

; Comments
(comment) @comment
(block_comment) @comment

; Keywords / special identifiers
"pragma" @keyword
"BuildVar" @keyword

; Spec definitions (like class declarations)
(spec_def
  name: (identifier) @type.definition)

; Mixin definitions
(mixin_def
  type: (type_ref) @type)

; Type references
(type_ref (identifier) @type)
(qualified_name
  lib: (identifier) @namespace
  name: (identifier) @type)

; Slot definitions (like field declarations)
(slot_def
  name: (identifier) @variable.field)

; Marker slots
(marker_slot
  name: (identifier) @variable.field)

; Global prefix
(global_prefix) @keyword.modifier

; Instance definitions
(instance_def
  id: (ref_literal) @variable.definition)

; References
(ref_literal) @string.special

; Meta tag names
(meta_tag
  key: (identifier) @attribute)

; String literals
(string_literal) @string
(triple_string) @string
(heredoc) @string

; Number literals
(number_literal) @number

; Typed scalars
(typed_scalar
  type: (type_ref) @type)

; Build variables
(build_var
  "BuildVar" @keyword)

; Operators
":" @operator
"::" @operator
"&" @operator
"|" @operator
"?" @operator
"+" @operator

; Punctuation
"{" @punctuation.bracket
"}" @punctuation.bracket
"<" @punctuation.bracket
">" @punctuation.bracket
"," @punctuation.delimiter
"." @punctuation.delimiter
