  export const formatTemplate = (
    template: string,
    values: Record<string, string | number>,
  ): string => {
    return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
      key in values ? String(values[key]) : placeholder,
    );
  }