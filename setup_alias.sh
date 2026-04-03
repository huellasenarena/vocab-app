#!/bin/bash
# setup_alias.sh — Crée l'alias 'kindle' pour lancer kindle_import.py depuis n'importe où

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/kindle_import.py"

if [ ! -f "$SCRIPT_PATH" ]; then
    echo "❌ kindle_import.py introuvable dans ce dossier."
    exit 1
fi

# Détecter le shell
SHELL_RC="$HOME/.zshrc"
if [ "$SHELL" = "/bin/bash" ]; then
    SHELL_RC="$HOME/.bashrc"
fi

ALIAS_LINE="alias kindle='python3 $SCRIPT_PATH'"

# Vérifier si l'alias existe déjà
if grep -q "alias kindle=" "$SHELL_RC" 2>/dev/null; then
    echo "✅ Alias 'kindle' déjà présent dans $SHELL_RC"
    echo "   Si tu veux le mettre à jour, supprime la ligne 'alias kindle=...' dans $SHELL_RC et relance ce script."
else
    echo "" >> "$SHELL_RC"
    echo "# Kindle → Google Sheets import" >> "$SHELL_RC"
    echo "$ALIAS_LINE" >> "$SHELL_RC"
    echo "✅ Alias 'kindle' ajouté dans $SHELL_RC"
fi

echo ""
echo "Pour activer l'alias maintenant, lance :"
echo "   source $SHELL_RC"
echo ""
echo "Ensuite, depuis n'importe où dans le terminal :"
echo "   kindle"
