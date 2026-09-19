; Axon source in function records
((block_tag
   name: (name) @_name
   value: (indented_text) @injection.content)
 (#eq? @_name "src")
 (#set! injection.language "axon"))

; Nested Trio record
((block_tag
   kind: (trio_block)
   value: (indented_text) @injection.content)
 (#set! injection.language "trio"))

((comment) @injection.content
 (#set! injection.language "comment"))
