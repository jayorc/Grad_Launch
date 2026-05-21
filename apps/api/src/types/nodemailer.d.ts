declare module "nodemailer" {
  const nodemailer: {
    createTransport(config: Record<string, unknown>): {
      sendMail(input: {
        from: string;
        to: string;
        subject: string;
        text: string;
        html: string;
      }): Promise<unknown>;
    };
  };

  export default nodemailer;
  export const createTransport: typeof nodemailer.createTransport;
}
