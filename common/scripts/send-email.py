#!/usr/bin/env python3
"""
Send email via SMTP.

Environment variables:
  SMTP_HOST    - SMTP server hostname (required)
  SMTP_PORT    - SMTP server port (default: 587 for STARTTLS)
  SMTP_USER    - SMTP username (required)
  SMTP_PASS    - SMTP password (required)
  SMTP_FROM    - Sender email address (required)

Usage:
  python3 send-email.py --to <addr> --subject <subj> --body <body> [--html]
"""

import argparse
import os
import re
import sys
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional

# Maximum recipients to prevent abuse
MAX_RECIPIENTS = 50

# Email address regex (RFC 5322 simplified)
EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')

# Characters not allowed in headers (prevents CRLF injection)
FORBIDDEN_HEADER_CHARS = re.compile(r'[\r\n]')


def validate_email(email: str) -> bool:
    """Validate email address format."""
    return bool(EMAIL_REGEX.match(email))


def validate_header(value: str) -> bool:
    """Validate header value doesn't contain CRLF characters."""
    return not FORBIDDEN_HEADER_CHARS.search(value)


def get_env(key: str, required: bool = True, default: Optional[str] = None) -> Optional[str]:
    """Get environment variable with optional default."""
    value = os.environ.get(key, default)
    if required and value is None:
        print(f"Error: {key} environment variable is required", file=sys.stderr)
        sys.exit(1)
    return value


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Send email via SMTP')
    parser.add_argument('--to', required=True, help='Recipient email address')
    parser.add_argument('--subject', required=True, help='Email subject')
    parser.add_argument('--body', required=True, help='Email body content')
    parser.add_argument('--html', action='store_true', help='Treat body as HTML')
    return parser.parse_args()


def send_email(
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_pass: str,
    smtp_from: str,
    to_addr: str,
    subject: str,
    body: str,
    is_html: bool = False
) -> None:
    """Send email via SMTP with STARTTLS."""

    # Validate sender and recipient
    if not validate_email(smtp_from):
        print(f"Error: Invalid sender email: {smtp_from}", file=sys.stderr)
        sys.exit(1)

    if not validate_email(to_addr):
        print(f"Error: Invalid recipient email: {to_addr}", file=sys.stderr)
        sys.exit(1)

    # Validate headers don't contain CRLF
    if not validate_header(subject):
        print("Error: Subject contains invalid characters", file=sys.stderr)
        sys.exit(1)

    if not validate_header(smtp_from):
        print("Error: From address contains invalid characters", file=sys.stderr)
        sys.exit(1)

    if not validate_header(to_addr):
        print("Error: To address contains invalid characters", file=sys.stderr)
        sys.exit(1)

    # Create message
    msg = EmailMessage()
    msg['From'] = smtp_from
    msg['To'] = to_addr
    msg['Subject'] = subject

    if is_html:
        msg.add_alternative(body, subtype='html')
    else:
        msg.set_content(body)

    # Create SSL context with secure settings
    context = ssl.create_default_context()

    # Connect and send with timeout
    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
            server.starttls(context=context)
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        print("Error: Authentication failed", file=sys.stderr)
        sys.exit(1)
    except smtplib.SMTPConnectError:
        print("Error: Could not connect to SMTP server", file=sys.stderr)
        sys.exit(1)
    except smtplib.SMTPException:
        print("Error: SMTP operation failed", file=sys.stderr)
        sys.exit(1)
    except TimeoutError:
        print(f"Error: Connection timed out", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    """Main entry point."""
    args = parse_args()

    # Get environment variables
    smtp_host = get_env('SMTP_HOST')
    smtp_port = int(get_env('SMTP_PORT', default='587'))
    smtp_user = get_env('SMTP_USER')
    smtp_pass = get_env('SMTP_PASS')  # CRITICAL: MUST be SMTP_PASS per AC-30
    smtp_from = get_env('SMTP_FROM')

    # Send email
    send_email(
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_user=smtp_user,
        smtp_pass=smtp_pass,
        smtp_from=smtp_from,
        to_addr=args.to,
        subject=args.subject,
        body=args.body,
        is_html=args.html
    )


if __name__ == '__main__':
    main()