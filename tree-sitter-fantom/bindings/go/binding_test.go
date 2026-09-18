package tree_sitter_fantom_test

import (
	"testing"

	tree_sitter "github.com/smacker/go-tree-sitter"
	"github.com/tree-sitter/tree-sitter-fantom"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_fantom.Language())
	if language == nil {
		t.Errorf("Error loading Fantom grammar")
	}
}
