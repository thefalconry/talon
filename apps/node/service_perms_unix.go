//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// requireOwnedPaths refuses to register a service running as uid when any
// of paths — or a directory above them — could be rewritten by another
// user: that user would get uid's rights (root, for a system unit) the next
// time the service starts. Catches e.g. TALON_NODE_DIR pointed at a
// user-writable directory for a root install.
//
// A path must be owned by uid (or root) and must not be writable by
// "other"; sticky directories (/tmp) are fine, since others can't replace
// entries they don't own there.
func requireOwnedPaths(uid uint32, paths ...string) error {
	for _, path := range paths {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		p, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		for {
			if err := checkOwnedPath(p, uid); err != nil {
				return err
			}
			parent := filepath.Dir(p)
			if parent == p {
				break
			}
			p = parent
		}
	}
	return nil
}

func checkOwnedPath(path string, uid uint32) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if st.Uid != uid && st.Uid != 0 {
		return fmt.Errorf(
			"%s is owned by uid %d: a service running as uid %d must not run "+
				"files another user can replace — install to a directory "+
				"only that account (or root) can write", path, st.Uid, uid)
	}
	mode := info.Mode()
	if mode.Perm()&0o002 != 0 && !(info.IsDir() && mode&os.ModeSticky != 0) {
		return fmt.Errorf(
			"%s is writable by every user: a service must not run files "+
				"another user can replace", path)
	}
	return nil
}
