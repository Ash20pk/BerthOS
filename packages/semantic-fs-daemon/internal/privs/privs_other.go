//go:build !linux

// Non-Linux stub: capability sets are a Linux kernel concept, and this
// daemon only ever runs on Linux (its FUSE and SO_PEERCRED dependencies are
// Linux-only too). The stub exists so tooling on a macOS dev machine can
// still typecheck the tree.
package privs

import "errors"

func NarrowPostMount() error {
	return errors.New("post-mount privilege narrowing is Linux-only")
}
