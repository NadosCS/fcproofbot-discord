function requireFileValue(value, name) {
  if (!value) {
    throw new TypeError(`Discord attachment ${name} is required.`);
  }

  return value;
}

export function createDiscordMultipartBody(payload, attachment) {
  const bytes = requireFileValue(attachment?.bytes, 'bytes');
  const contentType = requireFileValue(
    attachment?.contentType,
    'content type',
  );
  const filename = requireFileValue(attachment?.filename, 'filename');

  const data = {
    ...payload,
    attachments: [
      {
        id: 0,
        filename,
        description: attachment.description || 'Proof image',
      },
    ],
  };

  const form = new FormData();
  form.set('payload_json', JSON.stringify(data));
  form.set(
    'files[0]',
    new Blob([bytes], { type: contentType }),
    filename,
  );

  return form;
}
