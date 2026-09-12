"""Pieces shared by the node modules."""

import logging

class AnyType(str):
    def __ne__(self, other):
        return False


ANY = AnyType("*")


_LOG_CASE = logging.getLogger("obvpm")


def _lines(text):
    """A multiline widget's non-empty lines, trimmed."""
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]
